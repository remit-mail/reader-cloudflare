import { AuthCard, AuthHero, Banner, Button, ButtonLink } from "@remit/ui";
import type { AuthAccountProps, AuthProvider } from "@remit/web-client/auth/provider";
import { getRuntimeConfig } from "@remit/web-client/config";
import { type ReactNode, useCallback, useEffect, useState } from "react";

type Probe =
  | { readonly state: "checking" }
  | { readonly state: "ready" }
  | { readonly state: "signedOut" }
  | { readonly state: "failed"; readonly detail: string };

const IDENTITY_URL = "/cdn-cgi/access/get-identity";
const LOGOUT_URL = "/cdn-cgi/access/logout";
const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const emailOf = (body: unknown): string | null =>
  isRecord(body) && typeof body.email === "string" ? body.email : null;

const configUrl = (): string => `${getRuntimeConfig().apiUrl}/config`;

const classify = (response: Response): Probe => {
  if (response.type === "opaqueredirect") return { state: "signedOut" };
  if (response.status === 401 || response.status === 403) return { state: "signedOut" };
  if (response.ok) return { state: "ready" };
  return { state: "failed", detail: `GET ${configUrl()} returned ${response.status}.` };
};

const unreachable = (error: unknown): Probe => ({
  state: "failed",
  detail: `GET ${configUrl()} did not complete: ${error instanceof Error ? error.message : String(error)}.`,
});

const probeApi = (): Promise<Probe> =>
  fetch(configUrl(), { credentials: "same-origin", redirect: "manual" }).then(
    classify,
    unreachable,
  );

const reportUrl = (detail: string): string => {
  const params = new URLSearchParams({
    title: "remit cannot load its API",
    body: `${detail}\n\nPage: ${window.location.href}`,
  });
  return `${ISSUES_URL}?${params.toString()}`;
};

const currentLocation = (): string =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;

const Frame = ({ children }: { children: ReactNode }) => (
  <AuthCard>
    <AuthHero />
    <div className="mt-6 flex flex-col gap-4 rounded-lg border border-line bg-surface p-7 shadow-lg">
      {children}
    </div>
  </AuthCard>
);

const AccessShell = ({ children }: { children: ReactNode }) => {
  const [probe, setProbe] = useState<Probe>({ state: "checking" });

  const check = useCallback(() => {
    setProbe({ state: "checking" });
    probeApi().then(setProbe);
  }, []);

  useEffect(check, [check]);

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
        <ButtonLink href={currentLocation()}>Sign in again</ButtonLink>
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

const signOut = (): void => {
  window.location.assign(LOGOUT_URL);
};

const AccessAccount = ({ children }: AuthAccountProps) => {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch(IDENTITY_URL, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => setEmail(emailOf(body)));
  }, []);

  return <>{children({ email, signOut })}</>;
};

export const accessAuthProvider: AuthProvider = {
  configure: () => {},
  getToken: async () => null,
  resetToken: () => {},
  Shell: AccessShell,
  Account: AccessAccount,
};
