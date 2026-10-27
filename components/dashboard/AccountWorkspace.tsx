"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { AppHeader } from "@/components/ui/AppHeader";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/Button";
import { deleteAccount } from "@/lib/simulation/backendApi";
import { createAccount, logIn, logOut, refreshAccount, useAccountStore } from "@/lib/state/accountStore";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";

const INPUT = "mt-1 h-9 w-full border border-line bg-bg px-2.5 text-[13px] text-ink focus:border-data";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <h2 className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">{title}</h2>
      {children}
    </section>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function SignInForm() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signUp = mode === "sign-up";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (signUp) await createAccount(email, password, name);
      else await logIn(email, password);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={signUp ? "Create an account" : "Sign in"}>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
        Simulations that run on the backend — CFD (Mode C), the ML surrogate (Mode D), and Modes A and B when they are set to run
        there — are saved to your account. Everything computed in the browser works without one.
      </p>
      <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
        {signUp && (
          <label className="label block">
            Name <span className="text-ink-3">(optional)</span>
            <input className={INPUT} name="name" autoComplete="name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        <label className="label block">
          Email
          <input
            className={INPUT}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="label block">
          Password {signUp && <span className="text-ink-3">(at least 8 characters)</span>}
          <input
            className={INPUT}
            type="password"
            name="password"
            autoComplete={signUp ? "new-password" : "current-password"}
            required
            minLength={signUp ? 8 : 1}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs leading-relaxed text-err">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            type="button"
            className="text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              setMode(signUp ? "sign-in" : "sign-up");
              setError(null);
            }}
          >
            {signUp ? "I have an account — sign in" : "No account yet? Create one"}
          </button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : signUp ? "Create account" : "Sign in"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function AccountDetails() {
  const { user, cfdQuota, retentionDays } = useAccountStore();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const remove = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      await refreshAccount();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Your account">
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
          {user.name && (
            <>
              <dt className="text-ink-3">Name</dt>
              <dd className="text-ink">{user.name}</dd>
            </>
          )}
          <dt className="text-ink-3">Email</dt>
          <dd className="truncate text-ink">{user.email}</dd>
          <dt className="text-ink-3">Member since</dt>
          <dd className="text-ink">{new Date(user.createdAt * 1000).toLocaleDateString()}</dd>
        </dl>
        <div className="mt-5 flex gap-2">
          <AppLink href="/runs" className="inline-flex h-8 items-center border border-line px-3.5 text-[13px] font-medium text-ink hover:border-line-strong">
            Saved runs
          </AppLink>
          <Button onClick={() => void logOut().catch(() => undefined)}>Sign out</Button>
        </div>
      </Panel>
      <Panel title="Limits">
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-2">
          {cfdQuota && (
            <li>
              CFD (Mode C): {cfdQuota.limit} runs every {cfdQuota.windowMinutes} minutes, on the coarse or medium grid.{" "}
              <span className="text-ink">
                {Math.max(cfdQuota.limit - cfdQuota.used, 0)} of {cfdQuota.limit} left now.
              </span>
            </li>
          )}
          {retentionDays !== null && (
            <li>
              Saved runs and their CFD case files are deleted {retentionDays} days after the run started. Export results you want to
              keep from the Compare or Report pages.
            </li>
          )}
        </ul>
        <div className="mt-5 border-t border-line pt-4">
          {confirming ? (
            <form className="space-y-2" onSubmit={(event) => void remove(event)}>
              <label className="label block">
                Enter your password to delete the account and all its saved runs
                <input
                  className={INPUT}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="text-xs text-err">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={busy}>
                  {busy ? "Deleting…" : "Delete account"}
                </Button>
              </div>
            </form>
          ) : (
            <button type="button" className="text-xs text-ink-3 underline-offset-2 hover:text-err hover:underline" onClick={() => setConfirming(true)}>
              Delete this account…
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}

export function AccountWorkspace() {
  const status = useAccountStore((state) => state.status);
  const backend = useBackendStore((state) => state.status);
  const demoMode = useSettingsStore((state) => state.demoMode);

  let body: ReactNode;
  if (demoMode) {
    body = <p className="text-[13px] text-ink-2">Demo mode is on, so the backend is not contacted. Turn it off in Settings to sign in.</p>;
  } else if (backend !== "online" || status === "unknown") {
    body = (
      <p className="text-[13px] text-ink-2">
        {backend === "offline" ? "The backend is not reachable, so accounts are unavailable. Everything computed in the browser still works." : "Connecting to the backend…"}
      </p>
    );
  } else {
    body = status === "signed-in" ? <AccountDetails /> : <div className="max-w-[440px]"><SignInForm /></div>;
  }

  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Account</h1>
        <div className="mt-5">{body}</div>
      </main>
    </div>
  );
}
