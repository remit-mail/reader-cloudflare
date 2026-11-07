import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { audit } from "../audit";
import type { AuthDeps } from "../auth";
import {
  addressKey,
  addressOf,
  clearKey,
  refundKey,
  reserveAttempt,
  takeResetQuota,
  userKey,
} from "../backoff";
import { type LoginConfig, normalizeEmail } from "../config";
import { randomId, randomToken, sameHash, sha256Hex } from "../crypto";
import { json } from "../http";
import { log } from "../log";
import { reserveOrAudit } from "../second-factor";
import { recordTotpStep, totpStepMatchingNow } from "../totp";
import { isAssertion, passkeyCount, verifyOwnPasskey } from "../webauthn";

export const REAUTH_WINDOW_MS = 5 * 60_000;

const INVITE_LIFE_MS = 7 * 24 * 60 * 60_000;
const GRANT_LIFE_SECONDS = 30 * 60;
const GRANT_PATH = "/app/welcome";
const DEAD_INVITE =
  "This invite link no longer works. Ask the person who invited you for a new one.";
const PASSKEY_CHALLENGE_COOKIE = "better-auth-passkey";

export const grantCookieName = (config: LoginConfig): string =>
  config.loginOrigin.startsWith("https://") ? "__Secure-login-grant" : "login-grant";

const grantCookie = (config: LoginConfig, value: string, maxAge: number): string =>
  [
    `${grantCookieName(config)}=${value}`,
    `Path=${GRANT_PATH}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(config.loginOrigin.startsWith("https://") ? ["Secure"] : []),
  ].join("; ");

const tokenOf = (body: unknown): string | null => {
  const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(body);
  return parsed.success ? parsed.data.token : null;
};

const deadInvite = (): Response => json(410, { message: DEAD_INVITE });

const backoffResponse = (until: number): Response =>
  json(429, {
    message: "Too many attempts. Try again later.",
    retryAt: new Date(until).toISOString(),
  });

export const lookupInvite = async (
  db: D1Database,
  request: Request,
  body: unknown,
): Promise<Response> => {
  const address = addressOf(request);
  const now = Date.now();
  const reservation = await reserveAttempt(db, [addressKey(address)], now);
  if (!reservation.allowed) return backoffResponse(reservation.retryAt);
  const token = tokenOf(body);
  if (token === null) return deadInvite();
  const tokenHash = await sha256Hex(token);
  const invite = await db
    .prepare(
      "SELECT email, token_hash FROM invite WHERE token_hash = ? AND state = 'Open' AND expires_at > ?",
    )
    .bind(tokenHash, now)
    .first<{ email: string; token_hash: string }>();
  if (invite === null || !sameHash(invite.token_hash, tokenHash)) return deadInvite();
  await refundKey(db, addressKey(address));
  return json(200, { email: invite.email });
};

export const redeemInvite = async (
  db: D1Database,
  config: LoginConfig,
  request: Request,
  body: unknown,
): Promise<Response> => {
  const address = addressOf(request);
  const now = Date.now();
  const reservation = await reserveAttempt(db, [addressKey(address)], now);
  if (!reservation.allowed) return backoffResponse(reservation.retryAt);
  const token = tokenOf(body);
  if (token === null) return deadInvite();
  const tokenHash = await sha256Hex(token);
  const redeemed = await db
    .prepare(
      "UPDATE invite SET state = 'Redeemed', state_changed_at = ?1 WHERE token_hash = ?2 AND state = 'Open' AND expires_at > ?1 RETURNING invite_id, email, token_hash",
    )
    .bind(now, tokenHash)
    .first<{ invite_id: string; email: string; token_hash: string }>();
  if (redeemed === null || !sameHash(redeemed.token_hash, tokenHash)) {
    return deadInvite();
  }
  await refundKey(db, addressKey(address));
  const grant = randomToken();
  await db
    .prepare(
      "INSERT INTO onboarding_grant (onboarding_grant_id, invite_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      randomId(),
      redeemed.invite_id,
      redeemed.email,
      await sha256Hex(grant),
      now + GRANT_LIFE_SECONDS * 1000,
    )
    .run();
  await audit(db, {
    actor: "self",
    email: redeemed.email,
    address,
    event: "InviteRedeemed",
    outcome: "Succeeded",
  });
  return json(
    200,
    { email: redeemed.email },
    {
      "set-cookie": grantCookie(config, grant, GRANT_LIFE_SECONDS),
    },
  );
};

export const RESET_ACCEPTED = {
  message: "If that address has an account, a code is on its way. It expires in 10 minutes.",
};

export const requestReset = (
  db: D1Database,
  request: Request,
  body: unknown,
  waitUntil: (promise: Promise<unknown>) => void,
  send: (email: string) => Promise<unknown>,
): Response => {
  const parsed = z.object({ email: z.string().max(320) }).safeParse(body);
  const address = addressOf(request);
  if (parsed.success) {
    const email = normalizeEmail(parsed.data.email);
    waitUntil(
      (async () => {
        const allowed = await takeResetQuota(db, address, email, Date.now());
        if (!allowed) return;
        await audit(db, {
          actor: "anonymous",
          email,
          address,
          event: "ResetRequested",
          outcome: "Succeeded",
        });
        await send(email);
      })().catch((error: unknown) => {
        log.error("reset request failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }
  return json(202, RESET_ACCEPTED);
};

export const issueInvite = async (
  db: D1Database,
  email: string,
  issuedBy: string,
): Promise<{ readonly inviteId: string; readonly token: string }> => {
  const now = Date.now();
  const token = randomToken();
  const inviteId = randomId();
  await db.batch([
    db
      .prepare(
        "UPDATE invite SET state = 'Replaced', state_changed_at = ? WHERE email = ? AND state = 'Open'",
      )
      .bind(now, email),
    db
      .prepare(
        "INSERT INTO invite (invite_id, email, token_hash, state, created_at, expires_at, state_changed_at, issued_by) VALUES (?, ?, ?, 'Open', ?, ?, ?, ?)",
      )
      .bind(inviteId, email, await sha256Hex(token), now, now + INVITE_LIFE_MS, now, issuedBy),
  ]);
  return { inviteId, token };
};

export const revokeInvite = async (db: D1Database, inviteId: string): Promise<void> => {
  await db
    .prepare("UPDATE invite SET state = 'Revoked', state_changed_at = ? WHERE invite_id = ?")
    .bind(Date.now(), inviteId)
    .run();
};

const passwordSchema = z.object({ password: z.string() });

const confirmSchema = z.union([
  z.object({ password: z.string().min(1).max(128) }),
  z.object({ totpCode: z.string().regex(/^\d{6}$/) }),
  z.object({ passkey: z.unknown() }),
]);

export const appEndpoints = (deps: AuthDeps) => {
  const { db, config } = deps;
  return {
    id: "login-app",
    endpoints: {
      welcomePassword: createAuthEndpoint(
        "/app/welcome/password",
        { method: "POST", body: passwordSchema, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const grantToken = ctx.getCookie(grantCookieName(config));
          const refused = new APIError("FORBIDDEN", {
            message: "This step has expired. Open your invite link again.",
            code: "NO_GRANT",
          });
          if (!grantToken) throw refused;
          const tokenHash = await sha256Hex(grantToken);
          const now = Date.now();
          const grant = await db
            .prepare(
              "SELECT onboarding_grant_id, email, token_hash FROM onboarding_grant WHERE token_hash = ? AND expires_at > ?",
            )
            .bind(tokenHash, now)
            .first<{ onboarding_grant_id: string; email: string; token_hash: string }>();
          if (grant === null || !sameHash(grant.token_hash, tokenHash)) throw refused;
          const { password } = ctx.body;
          if (password.length < 12 || password.length > 128) {
            throw new APIError("BAD_REQUEST", {
              message: "Choose a password of 12 to 128 characters.",
              code: "PASSWORD_LENGTH",
            });
          }
          const hash = await ctx.context.password.hash(password);
          const consumed = await db
            .prepare(
              "DELETE FROM onboarding_grant WHERE onboarding_grant_id = ? AND expires_at > ? RETURNING email",
            )
            .bind(grant.onboarding_grant_id, now)
            .first<{ email: string }>();
          if (consumed === null) throw refused;
          if (await ctx.context.internalAdapter.findUserByEmail(consumed.email)) {
            throw new APIError("CONFLICT", {
              message: "This address already has an account. Sign in instead.",
              code: "ACCOUNT_EXISTS",
            });
          }
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: consumed.email,
              name: consumed.email.split("@")[0] ?? consumed.email,
              emailVerified: true,
            },
            { method: "email-password" },
          );
          await ctx.context.internalAdapter.linkAccount({
            userId: user.id,
            providerId: "credential",
            accountId: user.id,
            password: hash,
          });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          ctx.setHeader("set-cookie", grantCookie(config, "", 0));
          await audit(db, {
            actor: "self",
            email: user.email,
            address: addressOf({ headers: ctx.headers ?? new Headers() }),
            event: "SignIn",
            outcome: "Succeeded",
          });
          return ctx.json({ email: user.email });
        },
      ),
      securityConfirm: createAuthEndpoint(
        "/app/security/confirm",
        {
          method: "POST",
          body: confirmSchema,
          use: [sessionMiddleware],
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const address = addressOf({ headers: ctx.headers ?? new Headers() });
          const twoFactor = await db
            .prepare("SELECT secret FROM two_factor WHERE user_id = ?")
            .bind(user.id)
            .first<{ secret: string }>();
          const hasApp = Boolean(user.twoFactorEnabled) && twoFactor !== null;
          const hasPasskey = (await passkeyCount(db, user.id)) > 0;
          const body = ctx.body;
          if ("password" in body && (hasApp || hasPasskey)) {
            throw new APIError("FORBIDDEN", {
              message: "Confirm with your passkey or your authenticator app.",
              code: "FACTOR_REQUIRED",
            });
          }
          const personal = userKey(user.id);
          const reservation = await reserveOrAudit(db, [personal], user.email, user.email, address);
          if (!reservation.allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many attempts. Try again later.",
              code: "BACKOFF",
              retryAt: new Date(reservation.retryAt).toISOString(),
            });
          }
          const confirmed = await (async (): Promise<boolean> => {
            if ("password" in body) {
              const credential = (await ctx.context.internalAdapter.findAccounts(user.id)).find(
                (account) => account.providerId === "credential",
              );
              if (!credential?.password) return false;
              return ctx.context.password.verify({
                hash: credential.password,
                password: body.password,
              });
            }
            if ("totpCode" in body) {
              if (!hasApp || twoFactor === null) return false;
              const now = Date.now();
              const step = await totpStepMatchingNow(
                ctx.context.secretConfig,
                twoFactor.secret,
                body.totpCode,
                now,
              );
              return step !== null && recordTotpStep(db, user.id, step, "SecurityConfirm", now);
            }
            if (!hasPasskey || !isAssertion(body.passkey)) return false;
            const cookie = ctx.context.createAuthCookie(PASSKEY_CHALLENGE_COOKIE);
            const verificationId = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
            if (!verificationId) return false;
            const stored =
              await ctx.context.internalAdapter.consumeVerificationValue(verificationId);
            if (!stored) return false;
            const { type, expectedChallenge } = JSON.parse(stored.value) as {
              type?: string;
              expectedChallenge?: string;
            };
            if (type !== "authentication" || typeof expectedChallenge !== "string") return false;
            return verifyOwnPasskey(db, config, user.id, body.passkey, expectedChallenge);
          })();
          if (!confirmed) {
            throw new APIError("UNAUTHORIZED", {
              message: "That did not match. Try again.",
              code: "NOT_CONFIRMED",
            });
          }
          await clearKey(db, personal);
          await db
            .prepare("UPDATE session SET reauthenticated_at = ? WHERE id = ?")
            .bind(Date.now(), session.id)
            .run();
          return ctx.json({ confirmedUntil: Date.now() + REAUTH_WINDOW_MS });
        },
      ),
      appSignOut: createAuthEndpoint(
        "/app/sign-out",
        { method: "POST", use: [sessionMiddleware], metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          await db.batch([
            db.prepare("DELETE FROM oauth_access_token WHERE session_id = ?").bind(session.id),
            db.prepare("DELETE FROM session WHERE id = ?").bind(session.id),
          ]);
          deleteSessionCookie(ctx);
          await audit(db, {
            actor: "self",
            email: user.email,
            address: addressOf({ headers: ctx.headers ?? new Headers() }),
            event: "SignOut",
            outcome: "Succeeded",
          });
          return ctx.json({ redirect: `${config.readerOrigin}/cdn-cgi/access/logout` });
        },
      ),
      appSignOutEverywhere: createAuthEndpoint(
        "/app/sign-out-everywhere",
        { method: "POST", use: [sessionMiddleware], metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const { user } = ctx.context.session;
          await db.batch([
            db.prepare("DELETE FROM session WHERE user_id = ?").bind(user.id),
            db.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(user.id),
          ]);
          deleteSessionCookie(ctx);
          await audit(db, {
            actor: "self",
            email: user.email,
            address: addressOf({ headers: ctx.headers ?? new Headers() }),
            event: "SignOutEverywhere",
            outcome: "Succeeded",
          });
          return ctx.json({ redirect: `${config.readerOrigin}/cdn-cgi/access/logout` });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};
