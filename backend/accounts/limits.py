"""Usage limits: the Mode C quota of an account and in-memory sliding windows for everything else."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from accounts import config
from accounts.store import Store


@dataclass(frozen=True)
class Quota:
    limit: int
    window_s: float
    used: int
    #: Seconds until another run may start; 0 when one may start now.
    retry_after_s: float

    def to_json(self) -> dict[str, float]:
        return {
            "limit": self.limit,
            "windowMinutes": self.window_s / 60,
            "used": self.used,
            "retryAfterS": round(self.retry_after_s, 1),
        }


def cfd_quota(store: Store, user_id: str, now: float | None = None) -> Quota:
    """How many Mode C runs the account started in the current window. Counted from the database, so a
    restart of the server does not reset it."""
    now = time.time() if now is None else now
    limit, window = config.cfd_runs_per_window(), config.cfd_window_seconds()
    starts = store.cfd_run_times(user_id, now - window)
    # The window frees up when the oldest of the last `limit` runs leaves it.
    retry = max(starts[-limit] + window - now, 0.0) if len(starts) >= limit else 0.0
    return Quota(limit=limit, window_s=window, used=len(starts), retry_after_s=retry)


def describe_wait(seconds: float) -> str:
    seconds = max(int(seconds + 0.999), 1)
    minutes, rest = divmod(seconds, 60)
    return f"{minutes} min {rest} s" if minutes else f"{rest} s"


class SlidingWindow:
    """Allows `limit` events per key within `window_s` seconds."""

    def __init__(self, limit: int, window_s: float) -> None:
        self.limit = limit
        self.window_s = window_s
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, now: float | None = None) -> float:
        """Records an event. Returns 0 if it is allowed, otherwise the seconds until one would be."""
        now = time.monotonic() if now is None else now
        with self._lock:
            events = self._events[key]
            while events and events[0] <= now - self.window_s:
                events.popleft()
            if len(events) >= self.limit:
                return events[0] + self.window_s - now
            events.append(now)
            return 0.0

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


#: Sign-in attempts per client address, and per email address (guessing passwords).
login_by_address = SlidingWindow(limit=20, window_s=600)
login_by_email = SlidingWindow(limit=8, window_s=600)
#: New accounts per client address.
signups_by_address = SlidingWindow(limit=5, window_s=3600)
#: Jobs of any kind an account may create per minute (Modes A, B, D, sweeps, optimisation, training).
jobs_by_user = SlidingWindow(limit=60, window_s=60)

ALL_WINDOWS = (login_by_address, login_by_email, signups_by_address, jobs_by_user)
