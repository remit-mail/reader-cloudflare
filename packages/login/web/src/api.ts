export const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

import { type Refusal, refusalOf } from "./refusal";

export { type Failure, failureOf, SIGN_IN_LINK_EXPIRED } from "./refusal";

export type Answer =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | Refusal;

export type Refused = Refusal;

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

const bodyOf = async (response: Response): Promise<unknown> => {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return (response.headers.get("content-type") ?? "").startsWith("text/plain") ? text : {};
  }
};

const answerOf = async (response: Response): Promise<Answer> => {
  const body = await bodyOf(response);
  if (response.ok) return { ok: true, status: response.status, body: isRecord(body) ? body : {} };
  return refusalOf(response.status, body);
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

export const readerOriginOf = async (): Promise<string> => {
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

export const restartAuthorize = (): void => {
  const params = new URLSearchParams(window.location.search);
  for (const name of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"]) params.delete(name);
  window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
};

export const leave = async (answer: Answer): Promise<string | null> => {
  if (answer.ok && typeof answer.body.url === "string") {
    window.location.assign(answer.body.url);
    return null;
  }
  if (oauthQuery() !== undefined) {
    restartAuthorize();
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
