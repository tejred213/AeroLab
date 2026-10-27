/**
 * Typed client for the Python backend (FastAPI). The backend uses the same
 * camelCase JSON shapes as the TypeScript types. Every request carries the
 * session cookie of the signed-in account (`credentials: "include"`).
 */
import {
  type Fidelity,
  type JobProgress,
  type JobState,
  type SimulationConfig,
  SimulationError,
  type SimulationResult,
  type SurrogateInfo,
  type VehicleDefinition,
} from "@/lib/types";
import type { OptimizationRequest, OptimizationResult, OptimizationStep } from "@/lib/simulation/optimize";
import type { SweepRequest, SweepResult } from "@/lib/simulation/sweep";
import { type BackendInfo, useSettingsStore } from "@/lib/state/settingsStore";

const POLL_INTERVAL_MS = 250;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
/** A CFD run takes minutes to hours; the backend enforces its own limit (6 h by default). */
const CFD_JOB_TIMEOUT_MS = 7 * 60 * 60 * 1000;
const CFD_POLL_INTERVAL_MS = 1000;

export interface JobStatus<TResult = unknown, TPartial = unknown> {
  id: string;
  kind: string;
  state: JobState;
  progress: number;
  message: string;
  error: { code: string; message: string } | null;
  result: TResult | null;
  /** Intermediate output while the job is running (e.g. optimisation history). */
  partial: TPartial | null;
}

function baseUrl(): string {
  return useSettingsStore.getState().backendUrl;
}

/** The backend's address for messages: an empty base means this site's own /api. */
export function describeBackend(url: string): string {
  return url || "this site's /api";
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new SimulationError("TIMEOUT", `The backend did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw new SimulationError(
      "BACKEND_UNAVAILABLE",
      `Cannot reach the simulation backend at ${describeBackend(baseUrl())}. Start it with "npm run backend", or switch to browser computation.`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    let message = response.statusText || "Request failed";
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        code = detail.code ?? code;
        message = detail.message ?? message;
      } else if (Array.isArray(detail)) {
        code = "VALIDATION_ERROR";
        message = detail
          .map((item: { loc?: unknown[]; msg?: string }) => `${(item.loc ?? []).slice(1).join(".")}: ${item.msg}`)
          .join("; ");
      } else if (typeof detail === "string") {
        message = detail;
      }
    } catch {
      // Body was not JSON; keep the status text.
    }
    throw new SimulationError(code, message);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown, timeoutMs?: number) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);

/** What the backend measured on a surface it stored for Mode C. */
export interface CfdSurfaceInfo {
  id: string;
  triangles: number;
  min: number[];
  max: number[];
  frontalArea: number;
  area: number;
  sink: number;
}

/** Sends a closed surface (9 float32 values per triangle, tunnel coordinates) for Mode C to mesh. */
export function uploadCfdSurface(soup: Float32Array<ArrayBuffer>): Promise<CfdSurfaceInfo> {
  return request<CfdSurfaceInfo>(
    "/api/cfd/surfaces",
    { method: "POST", body: soup, headers: { "Content-Type": "application/octet-stream" } },
    180000,
  );
}

export function checkBackend(): Promise<BackendInfo> {
  return request<BackendInfo>("/api/health", {}, 2500);
}

/** Polls a job until it completes or fails. */
async function waitForJob<TResult, TPartial = unknown>(
  path: string,
  onStatus?: (status: JobStatus<TResult, TPartial>) => void,
  timeoutMs = JOB_TIMEOUT_MS,
  pollMs = POLL_INTERVAL_MS,
): Promise<JobStatus<TResult, TPartial>> {
  const started = Date.now();
  for (;;) {
    const status = await request<JobStatus<TResult, TPartial>>(path);
    onStatus?.(status);
    if (status.state === "COMPLETE") return status;
    if (status.state === "FAILED") {
      throw new SimulationError(status.error?.code ?? "SIMULATION_FAILED", status.error?.message ?? "The job failed.");
    }
    if (Date.now() - started > timeoutMs) {
      throw new SimulationError("TIMEOUT", "The backend job did not finish within the time limit.");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function simulateBackend(
  config: SimulationConfig,
  onProgress?: (progress: JobProgress) => void,
): Promise<SimulationResult> {
  const created = await post<{ id: string }>("/api/simulations", { config });
  await post<{ id: string }>(`/api/simulations/${created.id}/run`, {});
  const cfd = config.mode === "cfd";
  await waitForJob(
    `/api/simulations/${created.id}`,
    (status) => onProgress?.({ state: status.state, progress: status.progress, message: status.message }),
    cfd ? CFD_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS,
    cfd ? CFD_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
  );
  return request<SimulationResult>(`/api/simulations/${created.id}/results`);
}

export async function sweepBackend(
  sweep: SweepRequest,
  onProgress?: (done: number, total: number) => void,
): Promise<SweepResult> {
  const { jobId } = await post<{ jobId: string }>("/api/parameter-sweep", sweep);
  const total = sweep.valuesX.length * (sweep.paramY ? sweep.valuesY.length : 1);
  const status = await waitForJob<SweepResult>(`/api/jobs/${jobId}`, (job) =>
    onProgress?.(Math.round(job.progress * total), total),
  );
  return status.result as SweepResult;
}

export async function optimizeBackend(
  optimization: OptimizationRequest,
  onProgress?: (history: OptimizationStep[]) => void,
): Promise<OptimizationResult> {
  const { jobId } = await post<{ jobId: string }>("/api/optimization", optimization);
  const status = await waitForJob<OptimizationResult, OptimizationStep[]>(`/api/jobs/${jobId}`, (job) => {
    if (job.partial) onProgress?.(job.partial);
  });
  return status.result as OptimizationResult;
}

export interface SurrogateTrainRequest {
  config: SimulationConfig;
  /** Engine that generates the training data. */
  sourceMode: "analytical" | "reduced-order";
  samples: number;
  /** Geometry parameters varied in the dataset; others stay at the base geometry. */
  parameters: string[];
  /** Fraction of each parameter's allowed range sampled around the base value. */
  spread: number;
  seed: number;
}

/** Held-out validation score of one algorithm fitted during surrogate training. */
export interface SurrogateCandidate {
  key: string;
  algorithm: string;
  validationRmseCd: number;
  validationRmseCl: number;
  validationR2Cd: number;
  validationR2Cl: number;
  /** The algorithm with the best held-out score, used for prediction. */
  selected: boolean;
}

export interface SurrogateModel extends SurrogateInfo {
  createdAt: string;
  vehicleId: string;
  parameters: string[];
  speedRange: [number, number];
  validationSamples: number;
  /** Every algorithm that was fitted; absent for models stored by older versions. */
  candidates?: SurrogateCandidate[];
}

export async function trainSurrogate(
  training: SurrogateTrainRequest,
  onProgress?: (progress: JobProgress) => void,
): Promise<SurrogateModel> {
  const { jobId } = await post<{ jobId: string }>("/api/surrogate/train", training);
  const status = await waitForJob<SurrogateModel>(`/api/jobs/${jobId}`, (job) =>
    onProgress?.({ state: job.state, progress: job.progress, message: job.message }),
  );
  return status.result as SurrogateModel;
}

export function listSurrogates(): Promise<SurrogateModel[]> {
  return request<SurrogateModel[]>("/api/surrogate");
}

export function predictSurrogate(config: SimulationConfig): Promise<SimulationResult> {
  return post<SimulationResult>("/api/surrogate/predict", { config });
}

export function fetchVehicles(): Promise<VehicleDefinition[]> {
  return request<VehicleDefinition[]>("/api/vehicles");
}

export function saveVehicle(vehicle: VehicleDefinition): Promise<VehicleDefinition> {
  return post<VehicleDefinition>("/api/vehicles", vehicle);
}

export interface CfdCaseInfo {
  caseId: string;
  path: string;
  files: string[];
  solverAvailable: boolean;
  solverDetail: string;
  /** Mesh resolution of the case; follows the grid setting of the configuration. */
  meshSetting: Fidelity;
  /** Order-of-magnitude estimate, not the mesher's output. */
  cellEstimate: number;
  iterations: number;
  processors: number;
  prismLayers: number;
}

/** Generates an OpenFOAM case on the backend (does not run it). */
export function generateCfdCase(config: SimulationConfig): Promise<CfdCaseInfo> {
  return post<CfdCaseInfo>("/api/cfd/case", { config }, 60000);
}

export function cfdCaseDownloadUrl(caseId: string): string {
  return `${baseUrl()}/api/cfd/case/${caseId}/download`;
}

export interface CfdImportRequest {
  config: SimulationConfig;
  /** Contents of an OpenFOAM forceCoeffs output file (coefficient.dat). */
  coefficientFile: string;
}

/** Parses coefficients from a CFD run the user performed elsewhere. */
export function importCfdResult(payload: CfdImportRequest): Promise<SimulationResult> {
  return post<SimulationResult>("/api/cfd/import", payload);
}

// ---------------------------------------------------------------------------
// Accounts and saved runs
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  email: string;
  name: string;
  /** Unix time, s. */
  createdAt: number;
}

/** Mode C runs the account may start: `limit` per window of `windowMinutes`. */
export interface CfdQuota {
  limit: number;
  windowMinutes: number;
  used: number;
  /** Seconds until another Mode C run may start; 0 when one may start now. */
  retryAfterS: number;
}

export interface AccountState {
  user: Account | null;
  cfdQuota: CfdQuota | null;
  /** Saved runs and their case files are deleted this many days after they were created. */
  retentionDays: number;
}

export function fetchAccount(): Promise<AccountState> {
  return request<AccountState>("/api/auth/me", {}, 5000);
}

export function signUp(email: string, password: string, name: string): Promise<AccountState> {
  return post<AccountState>("/api/auth/register", { email, password, name });
}

export function signIn(email: string, password: string): Promise<AccountState> {
  return post<AccountState>("/api/auth/login", { email, password });
}

export function signOut(): Promise<AccountState> {
  return post<AccountState>("/api/auth/logout", {});
}

export function deleteAccount(password: string): Promise<AccountState> {
  return post<AccountState>("/api/auth/account/delete", { password });
}

/** A backend simulation saved with the account that ran it. Times are Unix time, s. */
export interface SavedRun {
  id: string;
  createdAt: number;
  expiresAt: number;
  finishedAt: number | null;
  mode: SimulationConfig["mode"];
  fidelity: Fidelity;
  vehicleId: string;
  state: JobState;
  progress: number;
  message: string;
  error: { code: string; message: string } | null;
  /** The result was served from the backend's cache: nothing was computed and no Mode C quota was used. */
  cached: boolean;
  coefficients: { cd: number; cl: number } | null;
  cells: number | null;
  wallTimeS: number | null;
}

export interface SavedRunDetail extends SavedRun {
  config: SimulationConfig;
  result: SimulationResult | null;
}

export function listRuns(): Promise<SavedRun[]> {
  return request<SavedRun[]>("/api/runs");
}

export function fetchRun(id: string): Promise<SavedRunDetail> {
  return request<SavedRunDetail>(`/api/runs/${encodeURIComponent(id)}`);
}

export function deleteRun(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
}
