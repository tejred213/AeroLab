"""In-process job system for simulations and other long-running tasks.

Jobs run on thread pools ("lanes") and move through the states

    QUEUED -> PREPARING -> MESHING -> SOLVING -> POST_PROCESSING -> COMPLETE
                                                                 \\-> FAILED

Each state is reported by the engine doing the work; nothing is simulated or
delayed for effect. A failed job keeps its error code and message so the UI can
say exactly what went wrong.

Mode C runs have a lane of their own with a single worker: one CFD run uses every core, so two at once would
only be slower, and the other modes stay responsive while it runs.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from simulation.assemble import SimulationError

JOB_STATES = ("QUEUED", "PREPARING", "MESHING", "SOLVING", "POST_PROCESSING", "COMPLETE", "FAILED")
MAX_STORED_JOBS = 400


@dataclass
class Job:
    id: str
    kind: str
    state: str = "QUEUED"
    progress: float = 0.0
    message: str = "Queued"
    error: dict[str, str] | None = None
    result: Any = None
    partial: Any = None
    payload: Any = None
    #: Id of the account that created the job; None for jobs made outside the API.
    owner: str | None = None
    lane: str = "default"
    created_at: float = field(default_factory=time.time)
    started: bool = False

    def status(self, include_result: bool = True) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "state": self.state,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "result": self.result if include_result else None,
            "partial": self.partial,
        }


#: A task receives its job (to report progress) and returns the result.
Task = Callable[[Job], Any]

#: Workers per lane.
LANES = {"default": 2, "cfd": 1}


class JobManager:
    def __init__(self, lanes: dict[str, int] = LANES) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._pools = {
            lane: ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"aerolab-{lane}") for lane, workers in lanes.items()
        }

    def create(self, kind: str, payload: Any = None, owner: str | None = None, lane: str = "default") -> Job:
        job = Job(id=uuid.uuid4().hex[:16], kind=kind, payload=payload, owner=owner, lane=lane)
        with self._lock:
            self._jobs[job.id] = job
            # Forget the oldest finished jobs once the store is full.
            if len(self._jobs) > MAX_STORED_JOBS:
                finished = sorted(
                    (j for j in self._jobs.values() if j.state in ("COMPLETE", "FAILED")), key=lambda j: j.created_at
                )
                for old in finished[: len(self._jobs) - MAX_STORED_JOBS]:
                    del self._jobs[old.id]
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def active(self, lane: str) -> int:
        """Jobs of a lane that are waiting for a worker or running (started but not finished)."""
        with self._lock:
            return sum(1 for job in self._jobs.values() if job.lane == lane and job.started and job.state not in ("COMPLETE", "FAILED"))

    def update(self, job: Job, state: str, progress: float, message: str) -> None:
        if job.state in ("COMPLETE", "FAILED"):
            return
        job.state = state
        job.progress = max(0.0, min(progress, 1.0))
        job.message = message

    def reporter(self, job: Job) -> Callable[[str, float, str], None]:
        return lambda state, progress, message: self.update(job, state, progress, message)

    def complete(self, job: Job, result: Any, message: str = "Complete") -> None:
        job.result = result
        job.state = "COMPLETE"
        job.progress = 1.0
        job.message = message

    def fail(self, job: Job, code: str, message: str) -> None:
        job.error = {"code": code, "message": message}
        job.state = "FAILED"
        job.message = "Failed"

    def start(self, job: Job, task: Task, on_finish: Callable[[Job], None] | None = None) -> None:
        """Runs the task on the job's lane. Starting an already started job is a no-op.

        `on_finish` is called with the job once it is COMPLETE or FAILED (to record it elsewhere)."""
        with self._lock:
            if job.started:
                return
            job.started = True

        def run() -> None:
            try:
                result = task(job)
                if job.state != "FAILED":
                    self.complete(job, result)
            except SimulationError as error:
                self.fail(job, error.code, error.message)
            except Exception as error:  # noqa: BLE001 - a job must never take the server down
                traceback.print_exc()
                self.fail(job, "SIMULATION_FAILED", f"{type(error).__name__}: {error}")
            if on_finish is not None:
                try:
                    on_finish(job)
                except Exception:  # noqa: BLE001 - recording a run must not change its outcome
                    traceback.print_exc()

        self._pools[job.lane].submit(run)


jobs = JobManager()
