import { create } from "zustand";
import { type Account, type CfdQuota, fetchAccount, signIn, signOut, signUp } from "@/lib/simulation/backendApi";

export type AccountStatus = "unknown" | "signed-out" | "signed-in";

interface AccountStoreState {
  status: AccountStatus;
  user: Account | null;
  cfdQuota: CfdQuota | null;
  retentionDays: number | null;
  /** When the quota was read, ms, so a countdown can be shown from it. */
  quotaReadAt: number;
}

/**
 * The account signed in on the backend (not persisted: the session itself is an HttpOnly cookie that only
 * the backend reads, so the page asks the backend who it is).
 */
export const useAccountStore = create<AccountStoreState>()(() => ({
  status: "unknown",
  user: null,
  cfdQuota: null,
  retentionDays: null,
  quotaReadAt: 0,
}));

function apply(state: { user: Account | null; cfdQuota: CfdQuota | null; retentionDays: number }): void {
  useAccountStore.setState({
    status: state.user ? "signed-in" : "signed-out",
    user: state.user,
    cfdQuota: state.cfdQuota,
    retentionDays: state.retentionDays,
    quotaReadAt: Date.now(),
  });
}

/** Asks the backend who is signed in. Never throws; an unreachable backend leaves the state unknown. */
export async function refreshAccount(): Promise<void> {
  try {
    apply(await fetchAccount());
  } catch {
    useAccountStore.setState({ status: "unknown", user: null, cfdQuota: null });
  }
}

export async function createAccount(email: string, password: string, name: string): Promise<void> {
  apply(await signUp(email, password, name));
}

export async function logIn(email: string, password: string): Promise<void> {
  apply(await signIn(email, password));
}

export async function logOut(): Promise<void> {
  apply(await signOut());
}

/** Seconds until the account may start another Mode C run, counted down from when the quota was read. */
export function cfdWaitSeconds(state: Pick<AccountStoreState, "cfdQuota" | "quotaReadAt">, now = Date.now()): number {
  if (!state.cfdQuota) return 0;
  return Math.max(state.cfdQuota.retryAfterS - (now - state.quotaReadAt) / 1000, 0);
}
