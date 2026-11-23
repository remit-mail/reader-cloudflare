import { AuthCard, AuthHero, Banner, Button, ButtonLink } from "@remit/ui";
import type { AuthAccountProps, AuthProvider } from "@remit/web-client/auth/provider";
import { getOfflineRuntime, type OfflineOptions } from "@remit/web-client/offline";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { verifySession } from "./access-session";

type Probe =
  | { readonly state: "checking" }
  | { readonly state: "ready" }
  | { readonly state: "signedOut" }
  | { readonly state: "failed"; readonly detail: string };

const IDENTITY_URL = "/cdn-cgi/access/get-identity";
const LOGIN_ORIGIN: string = import.meta.env.VITE_LOGIN_ORIGIN;
const LOGOUT_URL = `${LOGIN_ORIGIN}/sign-out`;
export const SECURITY_URL = `${LOGIN_ORIGIN}/security`;
const RENEWAL_KEY = "remit-access-renewal-at";
const RENEWAL_GUARD_MS = 60_000;
const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const emailOf = (body: unknown): string | null =>
  isRecord(body) && typeof body.email === "string" ? body.email : null;

const probeApi = (): Promise<Probe> =>
  verifySession().then(
    (session) => ({ state: session ? "ready" : "signedOut" }),
    (error: unknown) => ({
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );

const reportUrl = (detail: string): string => {
  const params = new URLSearchParams({
    title: "remit cannot load its API",
    body: `${detail}\n\nPage: ${window.location.href}`,
  });
  return `${ISSUES_URL}?${params.toString()}`;
};

const renewalUrl = (): string => {
  const url = new URL(window.location.href);
  url.searchParams.set("reauth", "1");
  return `${url.pathname}${url.search}${url.hash}`;
};

const renewedRecently = (): boolean => {
  try {
    const last = Number(window.sessionStorage.getItem(RENEWAL_KEY) ?? "0");
    const elapsed = Date.now() - last;
    return elapsed >= 0 && elapsed < RENEWAL_GUARD_MS;
  } catch {
    return true;
  }
};

const renewOnce = (): boolean => {
  if (renewedRecently()) return false;
  try {
    window.sessionStorage.setItem(RENEWAL_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.replace(renewalUrl());
  return true;
};

const Frame = ({ children }: { children: ReactNode }) => (
  <AuthCard>
    <AuthHero />
    <div className="mt-6 flex flex-col gap-4 rounded-lg border border-line bg-surface p-7 shadow-lg">
      {children}
    </div>
  </AuthCard>
);

const AccessSessionGate = ({ children }: { children: ReactNode }) => {
  const [probe, setProbe] = useState<Probe>({ state: "checking" });

  const check = useCallback(() => {
    setProbe({ state: "checking" });
    probeApi().then(setProbe);
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    if (probe.state === "signedOut") renewOnce();
  }, [probe.state]);

  if (probe.state === "ready") return <>{children}</>;
  if (probe.state === "checking") {
    return (
      <Frame>
        <p className="text-sm text-fg-muted">Connecting to remit…</p>
      </Frame>
    );
  }
  if (probe.state === "signedOut") {
    return (
      <Frame>
        <Banner tone="warning">
          Your Cloudflare Access session has ended. Sign in again to return to this page.
        </Banner>
        <ButtonLink href={renewalUrl()}>Sign in again</ButtonLink>
      </Frame>
    );
  }
  return (
    <Frame>
      <Banner tone="danger">
        remit could not load its API. {probe.detail} The Worker is not serving the API, or it is
        failing. Retry once it is deployed, or report the issue.
      </Banner>
      <Button onClick={check}>Retry</Button>
      <ButtonLink variant="ghost" href={reportUrl(probe.detail)} external>
        Report an issue
      </ButtonLink>
    </Frame>
  );
};

export const accessOffline: OfflineOptions = {
  verifySession: async () => {
    const session = await verifySession();
    // Remembered downloads bypass AccessSessionGate. Renew the Access cookie
    // here too, otherwise a cached shell leaves online users in read-only mode.
    if (!session && navigator.onLine) renewOnce();
    const url = new URL(window.location.href);
    if (session && url.searchParams.get("reauth") === "1") {
      url.searchParams.delete("reauth");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    return session;
  },
  reauthenticate: () => window.location.assign(renewalUrl()),
};

const signOut = async (): Promise<void> => {
  await getOfflineRuntime()?.removeDownloads();
  window.location.assign(LOGOUT_URL);
};

const AccessAccount = ({ children }: AuthAccountProps) => {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch(IDENTITY_URL, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (body: unknown) => setEmail(emailOf(body)),
        () => setEmail(null),
      );
  }, []);

  return <>{children({ email, signOut })}</>;
};

export const accessAuthProvider: AuthProvider = {
  reauthenticate: accessOffline.reauthenticate,
  configure: () => {},
  getToken: async () => null,
  resetToken: () => {},
  Shell: AccessSessionGate,
  SessionGate: AccessSessionGate,
  Account: AccessAccount,
};
