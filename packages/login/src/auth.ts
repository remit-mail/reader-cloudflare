import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, emailOTP, haveIBeenPwned, jwt, twoFactor } from "better-auth/plugins";
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
import { sendResetCode, sendSecurityChange } from "./mail";
import { appEndpoints, REAUTH_WINDOW_MS } from "./routes/app";
import {
  PASSKEY_SIGN_IN_PATH,
  RESET_PATH,
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
  "/email-otp/reset-password",
  "/passkey/generate-register-options",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
]);

const SERVER_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/email-otp/send-verification-otp",
  "/app/welcome/password",
  "/app/security/confirm",
  "/app/sign-out",
  "/app/sign-out-everywhere",
]);

const FACTOR_GATED: ReadonlySet<string> = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/change-password",
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
  ["/two-factor/enable", { event: "FactorAdded", change: "An authenticator app was added" }],
  ["/two-factor/disable", { event: "FactorRemoved", change: "The authenticator app was removed" }],
  [
    "/two-factor/generate-backup-codes",
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
      clientId: typeof ctx.body.client_id === "string" ? ctx.body.client_id : "none",
    });
    throw refuseAuthorizationCode("the sign-in behind this code has ended");
  });

const factorGate = createAuthMiddleware(async (ctx) => {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  const reauthenticatedAt = Number(
    (session.session as { reauthenticatedAt?: unknown }).reauthenticatedAt ?? 0,
  );
  if (Date.now() - reauthenticatedAt > REAUTH_WINDOW_MS) {
    throw new APIError("FORBIDDEN", {
      message: "Confirm it is you first.",
      code: "REAUTHENTICATE",
    });
  }
  if (ctx.path === "/change-password" && isRecord(ctx.body)) {
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
            ctx.path === RESET_PATH ||
            ctx.path === PASSKEY_SIGN_IN_PATH ||
            TWO_FACTOR_PATHS.has(ctx.path ?? ""),
          handler: before,
        },
        { matcher: (ctx) => FACTOR_GATED.has(ctx.path ?? ""), handler: factorGate },
        { matcher: (ctx) => ctx.path === "/oauth2/token", handler: tokenGuard },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === SIGN_IN_PATH ||
            ctx.path === RESET_PATH ||
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
      additionalFields: {
        reauthenticatedAt: { type: "number", required: true, input: false, defaultValue: 0 },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: Object.fromEntries(
        [SIGN_IN_PATH, RESET_PATH, ...TWO_FACTOR_PATHS].map((path) => [
          path,
          { window: 60, max: 30 },
        ]),
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
        rpName: "remit",
        origin: config.loginOrigin,
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
      }),
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "forget-password") return;
          const sent = await sendResetCode(deps.email, config, email, otp);
          if (sent.ok) return;
          log.warn("reset code email refused", { reason: sent.reason });
          await audit(deps.db, {
            actor: "anonymous",
            email,
            address: "",
            event: "ResetRequested",
            outcome: "Refused",
          });
        },
      }),
      haveIBeenPwned({
        paths: ["/email-otp/reset-password", "/change-password", "/app/welcome/password"],
      }),
      loginHooks(deps),
      appEndpoints(deps),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/sign-in",
        allowDynamicClientRegistration: false,
        grantTypes: ["authorization_code"],
        codeExpiresIn: 60,
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
