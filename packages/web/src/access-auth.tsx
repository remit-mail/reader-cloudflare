import { AuthCard, AuthHero, Banner, Button, ButtonLink } from "@remit/ui";
import type { AuthAccountProps, AuthProvider } from "@remit/web-client/auth/provider";
import { getOfflineRuntime } from "@remit/web-client/offline";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

const IDENTITY_URL = "/cdn-cgi/access/get-identity";
const LOGIN_ORIGIN: string = import.meta.env.VITE_LOGIN_ORIGIN;
const LOGOUT_URL = `${LOGIN_ORIGIN}/sign-out`;
export const SECURITY_URL = `${LOGIN_ORIGIN}/security`;
export const PEOPLE_URL = `${LOGIN_ORIGIN}/admin`;
export const SESSION_URL = "/api/session";
const RENEWAL_KEY = "remit-access-renewal-at";
const RENEWAL_GUARD_MS = 60_000;
const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const emailOf = (body: unknown): string | null =>
  isRecord(body) && typeof body.email === "string" ? body.email : null;

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

const useAccessSession = () => {
  // biome-ignore lint/style/noNonNullAssertion: mountApp installs the offline runtime before rendering the provider.
  const runtime = getOfflineRuntime()!;
  return {
    session: useSyncExternalStore(runtime.subscribe, runtime.snapshot).session,
    verify: runtime.verify,
  };
};

const AccessProbeProvider = ({ children }: { children: ReactNode }) => {
  const { session } = useAccessSession();

  useEffect(() => {
    if (session?.status === "signedOut" && navigator.onLine) renewOnce();
    if (session?.status !== "ready") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("reauth") !== "1") return;
    url.searchParams.delete("reauth");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [session]);

  return <>{children}</>;
};

const AccessSessionGate = ({ children }: { children: ReactNode }) => {
  const { session, verify } = useAccessSession();

  if (session?.status === "ready") return <>{children}</>;
  if (!session) {
    return (
      <Frame>
        <p className="text-sm text-fg-muted">Connecting to remit…</p>
      </Frame>
    );
  }
  if (session.status === "signedOut") {
    return (
      <Frame>
        <Banner tone="warning">
          Your Cloudflare Access session has ended. Sign in again to return to this page.
        </Banner>
        <ButtonLink href={renewalUrl()}>Sign in again</ButtonLink>
      </Frame>
    );
  }
  const error = session.status === "failed" ? session.error : "This device is offline.";
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <Frame>
      <Banner tone="danger">remit could not load its API. {detail}</Banner>
      <Button onClick={() => void verify()}>Retry</Button>
      <ButtonLink variant="ghost" href={reportUrl(detail)} external>
        Report an issue
      </ButtonLink>
    </Frame>
  );
};

const signOut = async (): Promise<void> => {
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
  reauthenticate: () => window.location.assign(renewalUrl()),
  configure: () => {},
  getToken: async () => null,
  resetToken: () => {},
  Provider: AccessProbeProvider,
  SessionGate: AccessSessionGate,
  Account: AccessAccount,
};
