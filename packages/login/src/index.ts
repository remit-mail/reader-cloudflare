import { WorkerEntrypoint, waitUntil } from "cloudflare:workers";
import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { isAPIError } from "better-auth/api";
import type {
  LoginOperatorService,
  OperatorAuditRecord,
} from "../../../src/operator-audit-contract";
import { audit, purgeStatements } from "./audit";
import { ALLOWED_AUTH_PATHS, API_BASE_PATH, type Auth, createAuth } from "./auth";
import { bootstrapOperators } from "./bootstrap";
import { type CapturedMail, capturesMail, latestCapturedMail, mailerOf } from "./capture";
import { configOf, isOperator, type LoginConfig } from "./config";
import type { Env } from "./env";
import { json, notFound, text } from "./http";
import { log } from "./log";
import {
  type AdminContext,
  openAdminChallenge,
  renderAdmin,
  renderAudit,
  runAdminAction,
} from "./routes/admin";
import { accessLogoutUrl, lookupInvite, redeemInvite } from "./routes/app";
import { lookupResetLink, type MailDeps, requestFreshLink, requestReset } from "./routes/reset";

const SPA_PAGES: ReadonlySet<string> = new Set([
  "/sign-in",
  "/sign-in/second-step",
  "/invite",
  "/welcome/password",
  "/welcome/second-step",
  "/welcome/backup-codes",
  "/reset",
  "/reset/password",
  "/security",
]);

const STATIC_FILES: ReadonlySet<string> = new Set(["/login.css", "/admin.js", "/favicon.svg"]);

const ACCESS_HEADERS = [
  "cf-access-client-id",
  "cf-access-client-secret",
  "cf-access-jwt-assertion",
];

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const carriesAccessCredentials = (request: Request): boolean =>
  ACCESS_HEADERS.some((name) => request.headers.has(name)) ||
  (request.headers.get("cookie") ?? "")
    .split(";")
    .some((cookie) => cookie.trim().startsWith("CF_Authorization="));

const isSafeMethod = (method: string): boolean => method === "GET" || method === "HEAD";

const withSecurityHeaders = (response: Response): Response => {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
};

const readJson = (request: Request): Promise<unknown> =>
  request.json().then(
    (body: unknown) => body,
    () => null,
  );

const signInLinkNotValid = (): Response =>
  new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in link not valid</title><link rel="stylesheet" href="/login.css"></head><body><main class="page"><section class="card"><h1>Sign-in link not valid</h1><p>Open remit again to start a new sign-in.</p></section></main></body></html>',
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const authorizeTargetIsSeeded = async (
  db: D1Database,
  config: LoginConfig,
  url: URL,
): Promise<boolean> => {
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (clientId !== config.clientId || redirectUri === null) return false;
  const row = await db
    .prepare("SELECT redirect_uris FROM oauth_client WHERE client_id = ?")
    .bind(clientId)
    .first<{ redirect_uris: string }>();
  if (row === null) return false;
  const registered: unknown = JSON.parse(row.redirect_uris);
  return Array.isArray(registered) && registered.includes(redirectUri);
};

const serveAuth = async (
  auth: Auth,
  env: Env,
  config: LoginConfig,
  request: Request,
  url: URL,
): Promise<Response> => {
  const path = url.pathname.slice(API_BASE_PATH.length);
  if (!ALLOWED_AUTH_PATHS.has(path)) return notFound();
  if (path === "/.well-known/openid-configuration") {
    return isSafeMethod(request.method)
      ? oauthProviderOpenIdConfigMetadata(auth)(request)
      : notFound();
  }
  if (path === "/oauth2/authorize" && !(await authorizeTargetIsSeeded(env.DB, config, url))) {
    return signInLinkNotValid();
  }
  return auth.handler(request);
};

const answered = (pending: Promise<Response>): Promise<Response> =>
  pending.catch((error: unknown) => {
    if (!isAPIError(error)) throw error;
    return json(error.statusCode, error.body ?? { message: error.message });
  });

const signOut = async (auth: Auth, config: LoginConfig, request: Request): Promise<Response> => {
  const { headers } = await auth.api.appSignOut({ headers: request.headers, returnHeaders: true });
  headers.set("location", accessLogoutUrl(config));
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
};

const serveApp = async (
  auth: Auth,
  env: Env,
  config: LoginConfig,
  request: Request,
  path: string,
): Promise<Response> => {
  const admin: AdminContext = {
    auth,
    config,
    db: env.DB,
    email: mailerOf(env),
    settings: env.OPERATOR_SETTINGS,
  };
  if (request.method === "GET" && path === "/app/config") {
    return Response.json({ readerOrigin: config.readerOrigin, passkeys: true });
  }
  if (request.method !== "POST") return notFound();
  const headers = request.headers;
  const mail: MailDeps = { db: env.DB, config, email: mailerOf(env), waitUntil };
  switch (path) {
    case "/app/invite/lookup":
      return lookupInvite(env.DB, request, await readJson(request));
    case "/app/invite/redeem":
      return redeemInvite(env.DB, config, request, await readJson(request));
    case "/app/reset/request":
      return requestReset(mail, request, await readJson(request));
    case "/app/reset/lookup":
      return lookupResetLink(env.DB, request, await readJson(request));
    case "/app/reset/password":
      return answered(
        auth.api.resetPassword({
          body: (await readJson(request)) as { token: string; password: string },
          headers,
          asResponse: true,
        }),
      );
    case "/app/link/fresh":
      return requestFreshLink(mail, request, await readJson(request));
    case "/app/second-step/app":
      return answered(auth.api.appEnroll({ headers, asResponse: true }));
    case "/app/welcome/password":
      return answered(
        auth.api.welcomePassword({
          body: (await readJson(request)) as { password: string },
          headers,
          asResponse: true,
        }),
      );
    case "/app/security/confirm":
      return answered(
        auth.api.securityConfirm({
          body: (await readJson(request)) as { password: string },
          headers,
          asResponse: true,
        }),
      );
    case "/app/sign-out-everywhere":
      return answered(auth.api.appSignOutEverywhere({ headers, asResponse: true }));
    case "/app/admin/challenge":
      return openAdminChallenge(admin, request, await readJson(request));
    case "/app/admin/action":
      return runAdminAction(admin, request, await readJson(request));
    default:
      return notFound();
  }
};

const route = async (request: Request, env: Env): Promise<Response> => {
  if (carriesAccessCredentials(request)) {
    return text(403, "Access credentials are not accepted on the login site.");
  }
  const config = configOf(env);
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    !isSafeMethod(request.method) &&
    path !== `${API_BASE_PATH}/oauth2/token` &&
    request.headers.get("origin") !== config.loginOrigin
  ) {
    return text(403, "This request came from a page the login site does not serve.");
  }
  if (isSafeMethod(request.method) && (SPA_PAGES.has(path) || path === "/")) {
    if (path === "/") return Response.redirect(`${config.loginOrigin}/sign-in`, 302);
    return env.ASSETS.fetch(new Request(new URL("/index.html", url), { method: request.method }));
  }
  if (isSafeMethod(request.method) && (STATIC_FILES.has(path) || path.startsWith("/assets/"))) {
    return env.ASSETS.fetch(request);
  }
  const auth = await createAuth(env, waitUntil);
  if (path.startsWith(`${API_BASE_PATH}/`)) return serveAuth(auth, env, config, request, url);
  const admin: AdminContext = {
    auth,
    config,
    db: env.DB,
    email: mailerOf(env),
    settings: env.OPERATOR_SETTINGS,
  };
  if (request.method === "GET" && path === "/sign-out") return signOut(auth, config, request);
  if (request.method === "GET" && path === "/admin") return renderAdmin(admin, request);
  if (request.method === "GET" && path === "/admin/audit") return renderAudit(admin, request);
  if (path.startsWith("/app/")) return serveApp(auth, env, config, request, path);
  return notFound();
};

export class CapturedMailReader extends WorkerEntrypoint<Env> {
  latest(): Promise<CapturedMail[]> {
    if (!capturesMail(this.env)) throw new Error("this login Worker does not capture mail");
    return latestCapturedMail(this.env.DB, Date.now());
  }
}

export class LoginOperator extends WorkerEntrypoint<Env> implements LoginOperatorService {
  private async emailOf(userId: string): Promise<string | null> {
    const row = await this.env.DB.prepare("SELECT email FROM user WHERE id = ?")
      .bind(userId)
      .first<{ email: string }>();
    return row?.email ?? null;
  }

  async isOperator(userId: string): Promise<boolean> {
    const email = await this.emailOf(userId);
    return email !== null && isOperator(configOf(this.env), email);
  }

  async writeAudit(record: OperatorAuditRecord): Promise<void> {
    const [actor, email] = await Promise.all([
      this.emailOf(record.actorId),
      this.emailOf(record.targetId),
    ]);
    if (actor === null || email === null) throw new Error("Operator audit user does not exist");
    const { actorId: _, targetId: __, ...entry } = record;
    await audit(this.env.DB, { ...entry, actor, email });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const started = Date.now();
    const response = await route(request, env);
    if (response.status >= 500) {
      log.error("request failed", { status: response.status, durationMs: Date.now() - started });
    }
    return withSecurityHeaders(response);
  },
  async scheduled(_controller, env): Promise<void> {
    const now = Date.now();
    const issued = await bootstrapOperators(env.DB, mailerOf(env), configOf(env), now);
    await env.DB.batch(purgeStatements(env.DB, now));
    log.info("login cron", { event: "cron", count: issued });
  },
} satisfies ExportedHandler<Env>;
