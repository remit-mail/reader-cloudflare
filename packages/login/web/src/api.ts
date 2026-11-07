export const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

export type Answer =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly code: string;
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
  };
};

const unreachable = (path: string, error: unknown): Answer => ({
  ok: false,
  status: 0,
  message: `The login site did not answer ${path}: ${error instanceof Error ? error.message : String(error)}.`,
  code: "NETWORK",
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

export const finish = async (answer: Answer): Promise<void> => {
  if (answer.ok && typeof answer.body.url === "string") {
    window.location.assign(answer.body.url);
    return;
  }
  const query = oauthQuery();
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    for (const name of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"]) params.delete(name);
    window.location.assign(`/api/auth/oauth2/authorize?${params.toString()}`);
    return;
  }
  const origin = await readerOriginOf().catch((error: unknown) => {
    window.dispatchEvent(
      new CustomEvent(FAILURE_EVENT, {
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  });
  if (origin === null) return;
  window.location.assign(
    returnTarget(new URLSearchParams(window.location.search).get("return"), origin),
  );
};
