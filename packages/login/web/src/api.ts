export const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

export type Answer =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly code: string;
      readonly retryAt: number | null;
    };

export type Refused = Extract<Answer, { ok: false }>;

export type Failure =
  | { readonly kind: "locked"; readonly message: string; readonly retryAt: number | null }
  | { readonly kind: "server"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export const failureOf = (answer: Refused): Failure => {
  if (answer.status === 429) {
    return { kind: "locked", message: answer.message, retryAt: answer.retryAt };
  }
  if (answer.status === 0 || answer.status >= 500) {
    return { kind: "server", message: answer.message };
  }
  return { kind: "refused", message: answer.message };
};

export const lockedUntil = (problem: { readonly kind: string } | null): number | null =>
  problem?.kind === "locked" && "retryAt" in problem && typeof problem.retryAt === "number"
    ? problem.retryAt
    : null;

export const untilRetry = (
  retryAt: number | null,
  reopen: () => void,
): (() => void) | undefined => {
  if (retryAt === null) return undefined;
  const timer = setTimeout(reopen, Math.max(0, retryAt - Date.now()));
  return () => clearTimeout(timer);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const retryText = (retryAt: unknown): string =>
  typeof retryAt === "string" ? ` Try again after ${new Date(retryAt).toLocaleTimeString()}.` : "";

const answerOf = async (response: Response): Promise<Answer> => {
  const body: unknown = await response.json().catch(() => ({}));
  const record = isRecord(body) ? body : {};
  if (response.ok) return { ok: true, status: response.status, body: record };
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : `The login site answered ${response.status}.`;
  return {
    ok: false,
    status: response.status,
    message: `${message}${response.status === 429 ? retryText(record.retryAt) : ""}`,
    code: typeof record.code === "string" ? record.code : "",
    retryAt: typeof record.retryAt === "string" ? Date.parse(record.retryAt) || null : null,
  };
};

const unreachable = (path: string, error: unknown): Answer => ({
  ok: false,
  status: 0,
  message: `The login site did not answer ${path}: ${error instanceof Error ? error.message : String(error)}.`,
  code: "NETWORK",
  retryAt: null,
});

export const post = (path: string, body: unknown = {}): Promise<Answer> =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(answerOf, (error: unknown) => unreachable(path, error));

export const get = (path: string): Promise<Answer> =>
  fetch(path, { credentials: "same-origin" }).then(answerOf, (error: unknown) =>
    unreachable(path, error),
  );

export const reportUrl = (detail: string): string =>
  `${ISSUES_URL}?${new URLSearchParams({
    title: "remit sign-in failed",
    body: `${detail}\n\nPage: ${window.location.pathname}`,
  }).toString()}`;

export const oauthQuery = (): string | undefined => {
  const query = window.location.search.slice(1);
  return new URLSearchParams(query).has("sig") ? query : undefined;
};

export const withOAuth = (body: Record<string, unknown>): Record<string, unknown> => {
  const query = oauthQuery();
  return query === undefined ? body : { ...body, oauth_query: query };
};

export const navigate = (path: string, state?: unknown): void => {
  window.history.pushState(state ?? null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const keepQuery = (path: string): string => `${path}${window.location.search}`;

export const FAILURE_EVENT = "login-failure";

let readerOrigin: string | null = null;

const readerOriginOf = async (): Promise<string> => {
  if (readerOrigin !== null) return readerOrigin;
  const config = await get("/app/config");
  if (!config.ok || typeof config.body.readerOrigin !== "string") {
    throw new Error(
      `GET /app/config did not name the reader origin: ${config.ok ? "no readerOrigin" : config.message}`,
    );
  }
  readerOrigin = config.body.readerOrigin;
  return readerOrigin;
};

export const returnTarget = (requested: string | null, readerOrigin: string): string => {
  const root = new URL("/", readerOrigin).toString();
  if (requested === null) return root;
  const target = URL.canParse(requested, readerOrigin) ? new URL(requested, readerOrigin) : null;
  return target?.origin === new URL(readerOrigin).origin ? target.toString() : root;
};

export const leave = async (answer: Answer): Promise<string | null> => {
  if (answer.ok && typeof answer.body.url === "string") {
    window.location.assign(answer.body.url);
    return null;
  }
  const query = oauthQuery();
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    for (const name of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"]) params.delete(name);
    window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
    return null;
  }
  const origin = await readerOriginOf().then(
    (found): { readonly found: string } | { readonly failure: string } => ({ found }),
    (error: unknown) => ({ failure: error instanceof Error ? error.message : String(error) }),
  );
  if ("failure" in origin) return origin.failure;
  window.location.assign(
    returnTarget(new URLSearchParams(window.location.search).get("return"), origin.found),
  );
  return null;
};

export const finish = async (answer: Answer): Promise<void> => {
  const failure = await leave(answer);
  if (failure === null) return;
  window.dispatchEvent(new CustomEvent(FAILURE_EVENT, { detail: failure }));
};

let linkToken: string | null = null;

export const takeLinkToken = (): string | null => {
  const fragment = window.location.hash.slice(1);
  if (fragment) {
    linkToken = fragment;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return linkToken;
};

export const dropLinkToken = (): void => {
  linkToken = null;
};
