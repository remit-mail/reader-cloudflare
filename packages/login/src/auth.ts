import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, haveIBeenPwned, jwt, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { audit } from "./audit";
import { addressOf } from "./backoff";
import { mailerOf } from "./capture";
import { configOf, type LoginConfig } from "./config";
import { sha256Base64Url, sha256Hex } from "./crypto";
import { schema } from "./db/schema";
import type { Env } from "./env";
import { isRecord } from "./http";
import { log } from "./log";
import { sendSecurityChange } from "./mail";
import { APP_ENROLL_PATH, appEndpoints } from "./routes/app";
import { RESET_PASSWORD_PATH, resetEndpoints } from "./routes/reset";
import {
  PASSKEY_SIGN_IN_PATH,
  SIGN_IN_PATH,
  secondFactorAfter,
  secondFactorBefore,
  TWO_FACTOR_PATHS,
} from "./second-factor";

const DAY_SECONDS = 24 * 60 * 60;

export const API_BASE_PATH = "/api/auth";

export const ALLOWED_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/.well-known/openid-configuration",
  "/jwks",
  "/oauth2/authorize",
  "/oauth2/userinfo",
  "/oauth2/token",
  "/get-session",
  "/sign-in/email",
  "/change-password",
  "/passkey/generate-register-options",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

const SERVER_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/app/welcome/password",
  RESET_PASSWORD_PATH,
  APP_ENROLL_PATH,
  "/app/security/disable-app",
  "/app/security/backup-codes",
  "/app/sign-out",
  "/app/sign-out-everywhere",
]);

type FactorEvent =
  | "FactorAdded"
  | "FactorRemoved"
  | "FactorRenamed"
  | "BackupCodesRegenerated"
  | "PasswordChanged";

const FACTOR_CHANGES: ReadonlyMap<
  string,
  { readonly event: FactorEvent; readonly change: string }
> = new Map([
  ["/passkey/verify-registration", { event: "FactorAdded", change: "A passkey was added" }],
  ["/passkey/delete-passkey", { event: "FactorRemoved", change: "A passkey was removed" }],
  ["/passkey/update-passkey", { event: "FactorRenamed", change: "A passkey was renamed" }],
  [APP_ENROLL_PATH, { event: "FactorAdded", change: "An authenticator app was added" }],
  [
    "/app/security/disable-app",
    { event: "FactorRemoved", change: "The authenticator app was removed" },
  ],
  [
    "/app/security/backup-codes",
    { event: "BackupCodesRegenerated", change: "New backup codes were made" },
  ],
  ["/change-password", { event: "PasswordChanged", change: "The password was changed" }],
]);

export interface AuthDeps {
  readonly config: LoginConfig;
  readonly db: D1Database;
  readonly email: SendEmail;
  readonly secret: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

const refuseAuthorizationCode = (description: string): APIError =>
  new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: description });

const basicClientId = (authorization: string | null): string | null => {
  if (!authorization?.startsWith("Basic ")) return null;
  const decoded = atob(authorization.slice("Basic ".length).trim());
  const separator = decoded.indexOf(":");
  return separator === -1 ? null : decodeURIComponent(decoded.slice(0, separator));
};

const tokenRaceGuard = (db: D1Database) =>
  createAuthMiddleware(async (ctx) => {
    if (!isRecord(ctx.body) || ctx.body.grant_type !== "authorization_code") return;
    const code = ctx.body.code;
    if (typeof code !== "string") return;
    const row = await db
      .prepare("SELECT value FROM verification WHERE identifier = ?")
      .bind(await sha256Base64Url(code))
      .first<{ value: string }>();
    if (row === null) return;
    const stored: unknown = JSON.parse(row.value);
    if (!isRecord(stored) || typeof stored.userId !== "string") {
      throw refuseAuthorizationCode("authorization code holds no user");
    }
    const live =
      typeof stored.sessionId === "string"
        ? await db
            .prepare(
              "SELECT session.id FROM session JOIN user ON user.id = session.user_id WHERE session.id = ? AND session.user_id = ? AND session.expires_at > ? AND COALESCE(user.banned, 0) = 0",
            )
            .bind(stored.sessionId, stored.userId, Date.now())
            .first()
        : await db
            .prepare(
              "SELECT session.id FROM session JOIN user ON user.id = session.user_id WHERE session.user_id = ? AND session.expires_at > ? AND COALESCE(user.banned, 0) = 0 LIMIT 1",
            )
            .bind(stored.userId, Date.now())
            .first();
    if (live !== null) return;
    const user = await db
      .prepare("SELECT email FROM user WHERE id = ?")
      .bind(stored.userId)
      .first<{ email: string }>();
    await audit(db, {
      actor: "self",
      email: user?.email ?? "",
      address: addressOf({ headers: ctx.headers ?? new Headers() }),
      event: "TokenIssued",
      outcome: "Refused",
      clientId:
        basicClientId(ctx.headers?.get("authorization") ?? null) ??
        (typeof ctx.body.client_id === "string" ? ctx.body.client_id : "none"),
    });
    throw refuseAuthorizationCode("the sign-in behind this code has ended");
  });

const changePassword = createAuthMiddleware(async (ctx) => {
  if (isRecord(ctx.body)) {
    return { context: { body: { ...ctx.body, revokeOtherSessions: true } } };
  }
});

const loginHooks = (deps: AuthDeps): BetterAuthPlugin => {
  const before = secondFactorBefore(deps.db);
  const after = secondFactorAfter(deps.db);
  const tokenGuard = tokenRaceGuard(deps.db);
  return {
    id: "login-hooks",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === SIGN_IN_PATH ||
            ctx.path === PASSKEY_SIGN_IN_PATH ||
            TWO_FACTOR_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (isRecord(ctx.body) && typeof ctx.body.oauth_query === "string") {
              const exp = new URLSearchParams(ctx.body.oauth_query).get("exp");
              if (exp !== null && Number(exp) * 1000 < Date.now()) delete ctx.body.oauth_query;
            }
            await before(ctx);
          }),
        },
        { matcher: (ctx) => ctx.path === "/change-password", handler: changePassword },
        { matcher: (ctx) => ctx.path === "/oauth2/token", handler: tokenGuard },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === SIGN_IN_PATH ||
            ctx.path === PASSKEY_SIGN_IN_PATH ||
            TWO_FACTOR_PATHS.has(ctx.path ?? ""),
          handler: after,
        },
        {
          matcher: (ctx) => FACTOR_CHANGES.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return;
            const session = ctx.context.newSession ?? (await getSessionFromCtx(ctx));
            if (!session) return;
            const factorChange = FACTOR_CHANGES.get(ctx.path);
            if (factorChange === undefined) return;
            const { event, change } = factorChange;
            const address = addressOf({ headers: ctx.headers ?? new Headers() });
            await audit(deps.db, {
              actor: "self",
              email: session.user.email,
              address,
              event,
              outcome: "Succeeded",
            });
            deps.waitUntil(
              sendSecurityChange(deps.email, deps.config, session.user.email, change).then(
                (sent) => {
                  if (!sent.ok) log.warn("security change email refused", { reason: sent.reason });
                },
              ),
            );
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!isRecord(returned) || typeof returned.access_token !== "string") return;
            const issued = await deps.db
              .prepare(
                "SELECT user.email AS email, oauth_access_token.client_id AS client_id FROM oauth_access_token JOIN user ON user.id = oauth_access_token.user_id WHERE oauth_access_token.token = ?",
              )
              .bind(await sha256Base64Url(returned.access_token))
              .first<{ email: string; client_id: string }>();
            if (issued === null) return;
            await audit(deps.db, {
              actor: "self",
              email: issued.email,
              address: addressOf({ headers: ctx.headers ?? new Headers() }),
              event: "TokenIssued",
              outcome: "Succeeded",
              clientId: issued.client_id,
            });
          }),
        },
      ],
    },
  };
};

export const authOptions = (deps: AuthDeps, disabledPaths: string[]) => {
  const { config } = deps;
  return {
    appName: "remit",
    database: drizzleAdapter(drizzle(deps.db), { provider: "sqlite", schema }),
    secret: deps.secret,
    baseURL: `${config.loginOrigin}${API_BASE_PATH}`,
    basePath: API_BASE_PATH,
    trustedOrigins: [config.loginOrigin],
    disabledPaths,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 90 * DAY_SECONDS,
      updateAge: DAY_SECONDS,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: Object.fromEntries(
        [SIGN_IN_PATH, ...TWO_FACTOR_PATHS].map((path) => [path, { window: 60, max: 30 }]),
      ),
    },
    advanced: {
      useSecureCookies: config.loginOrigin.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      backgroundTasks: { handler: deps.waitUntil },
    },
    plugins: [
      admin(),
      jwt({
        jwks: {
          keyPairConfig: { alg: "RS256", modulusLength: 2048 },
          rotationInterval: 90 * DAY_SECONDS,
          gracePeriod: 2 * DAY_SECONDS,
        },
      }),
      twoFactor({
        issuer: "remit",
        backupCodeOptions: { amount: 10, storeBackupCodes: "encrypted" },
        accountLockout: { enabled: false },
      }),
      passkey({
        rpID: config.loginHostname,
        // Skip the plugin's freshness middleware. With no resolveUser callback,
        // registration still requires an authoritative session and binds its challenge to it.
        registration: { requireSession: false },
        rpName: "remit",
        origin: config.loginOrigin,
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
      }),
      haveIBeenPwned({
        paths: [RESET_PASSWORD_PATH, "/change-password", "/app/welcome/password"],
      }),
      loginHooks(deps),
      appEndpoints(deps),
      resetEndpoints(deps),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/sign-in",
        allowDynamicClientRegistration: false,
        grantTypes: ["authorization_code"],
        // The sign-in hook drops an expired query before the OAuth provider reads it.
        codeExpiresIn: 600,
        accessTokenExpiresIn: 900,
        idTokenExpiresIn: 900,
        cachedTrustedClients: new Set([config.clientId]),
        scopes: ["openid", "email", "profile"],
        storeClientSecret: "hashed",
        customIdTokenClaims: ({ user, scopes }) =>
          scopes.includes("email") ? { email: user.email, email_verified: user.emailVerified } : {},
      }),
    ],
  } satisfies BetterAuthOptions;
};

const build = (deps: AuthDeps) => {
  const probe = betterAuth(authOptions(deps, []));
  const disabledPaths = Object.values(probe.api)
    .map((endpoint) => (endpoint as { path?: string }).path)
    .filter((path): path is string => typeof path === "string")
    .filter((path) => !ALLOWED_AUTH_PATHS.has(path) && !SERVER_ONLY_PATHS.has(path));
  return betterAuth(authOptions(deps, [...new Set(disabledPaths)]));
};

export type Auth = ReturnType<typeof build>;

const cache = new WeakMap<Env, { readonly key: string; readonly auth: Auth }>();

export const createAuth = async (
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Auth> => {
  const secret = await env.LOGIN_AUTH_SECRET.get();
  const key = await sha256Hex(`${secret}|${env.LOGIN_ORIGIN}|${env.OPERATOR_EMAILS}`);
  const cached = cache.get(env);
  if (cached?.key === key) return cached.auth;
  const auth = build({
    config: configOf(env),
    db: env.DB,
    email: mailerOf(env),
    secret,
    waitUntil: (promise) => waitUntil(promise),
  });
  cache.set(env, { key, auth });
  return auth;
};
