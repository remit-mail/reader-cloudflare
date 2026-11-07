import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { audit } from "./audit";
import {
  type AttemptKey,
  accountKey,
  addressKey,
  addressOf,
  clearKey,
  type Reservation,
  refundKey,
  reserveAttempt,
} from "./backoff";
import { isRecord } from "./http";
import { passkeyCount } from "./webauthn";

type MiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const PENDING_COOKIE = "pending_second_step";
const PENDING_SECONDS = 600;
const TWO_FACTOR_COOKIE = "two_factor";

export const SIGN_IN_PATH = "/sign-in/email";
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";
export const TWO_FACTOR_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);
export const RESET_PATH = "/email-otp/reset-password";

const addressOfContext = (ctx: MiddlewareContext): string =>
  addressOf({ headers: ctx.headers ?? new Headers() });

const stringField = (body: unknown, name: string): string | undefined => {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === "string" ? value : undefined;
};

export const failed = (ctx: MiddlewareContext): boolean => ctx.context.returned instanceof APIError;

export const reserveOrAudit = async (
  db: D1Database,
  keys: readonly AttemptKey[],
  actor: string,
  email: string,
  address: string,
): Promise<Reservation> => {
  const reservation = await reserveAttempt(db, keys, Date.now());
  if (reservation.allowed && reservation.firstDelay) {
    await audit(db, { actor, email, address, event: "Backoff", outcome: "Refused" });
  }
  return reservation;
};

const reserveOrThrow = async (
  db: D1Database,
  keys: readonly AttemptKey[],
  email: string,
  address: string,
): Promise<void> => {
  const reservation = await reserveOrAudit(db, keys, "anonymous", email, address);
  if (reservation.allowed) return;
  throw new APIError("TOO_MANY_REQUESTS", {
    message: "Too many attempts. Try again later.",
    code: "BACKOFF",
    retryAt: new Date(reservation.retryAt).toISOString(),
  });
};

export const settleSuccess = async (
  db: D1Database,
  address: string,
  personal: AttemptKey,
): Promise<void> => {
  await clearKey(db, personal);
  await refundKey(db, addressKey(address));
};

const twoFactorPendingEmail = async (ctx: MiddlewareContext): Promise<string | null> => {
  const session = await getSessionFromCtx(ctx);
  if (session) return session.user.email;
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const verification = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!verification) return null;
  const user = await ctx.context.internalAdapter.findUserById(verification.value);
  return user?.email ?? null;
};

const pendingUserId = async (ctx: MiddlewareContext): Promise<string | null> => {
  const cookie = ctx.context.createAuthCookie(PENDING_COOKIE);
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!value) return null;
  const [userId, expiresAt] = value.split("|");
  if (!userId || Number(expiresAt) < Date.now()) return null;
  return userId;
};

const credentialIdOf = (body: unknown): string | undefined => {
  if (!isRecord(body) || !isRecord(body.response)) return undefined;
  const id = body.response.id;
  return typeof id === "string" ? id : undefined;
};

export const secondFactorBefore = (db: D1Database) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === PASSKEY_SIGN_IN_PATH) {
      const pending = await pendingUserId(ctx);
      if (pending === null) return;
      const credentialId = credentialIdOf(ctx.body);
      const passkey = credentialId
        ? await ctx.context.adapter.findOne<{ userId: string }>({
            model: "passkey",
            where: [{ field: "credentialID", value: credentialId }],
          })
        : null;
      if (passkey?.userId !== pending) {
        throw new APIError("FORBIDDEN", {
          message: "Use a passkey of the account you signed in to.",
          code: "PASSKEY_OF_ANOTHER_ACCOUNT",
        });
      }
      return;
    }
    const address = addressOfContext(ctx);
    if (ctx.path === SIGN_IN_PATH || ctx.path === RESET_PATH) {
      const email = stringField(ctx.body, "email") ?? "";
      await reserveOrThrow(db, [addressKey(address), await accountKey(email)], email, address);
      return;
    }
    if (TWO_FACTOR_PATHS.has(ctx.path)) {
      if (isRecord(ctx.body) && ctx.body.trustDevice === true) {
        throw new APIError("BAD_REQUEST", { message: "Trusted devices are not offered." });
      }
      const email = await twoFactorPendingEmail(ctx);
      const keys = email ? [addressKey(address), await accountKey(email)] : [addressKey(address)];
      await reserveOrThrow(db, keys, email ?? "", address);
    }
  });

const afterSignIn = async (db: D1Database, ctx: MiddlewareContext, address: string) => {
  const email = stringField(ctx.body, "email") ?? "";
  if (failed(ctx)) {
    await audit(db, { actor: "anonymous", email, address, event: "SignIn", outcome: "Refused" });
    return;
  }
  const created = ctx.context.newSession;
  if (!created) return;
  await refundKey(db, addressKey(address));
  if (created.user.twoFactorEnabled) {
    await audit(db, {
      actor: "self",
      email,
      address,
      event: "SecondStepRequired",
      outcome: "Succeeded",
    });
    return;
  }
  if ((await passkeyCount(db, created.user.id)) === 0) {
    await clearKey(db, await accountKey(email));
    await audit(db, { actor: "self", email, address, event: "SignIn", outcome: "Succeeded" });
    return;
  }
  deleteSessionCookie(ctx, true);
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);
  const cookie = ctx.context.createAuthCookie(PENDING_COOKIE, { maxAge: PENDING_SECONDS });
  await ctx.setSignedCookie(
    cookie.name,
    `${created.user.id}|${Date.now() + PENDING_SECONDS * 1000}`,
    ctx.context.secret,
    cookie.attributes,
  );
  await audit(db, {
    actor: "self",
    email,
    address,
    event: "SecondStepRequired",
    outcome: "Succeeded",
  });
  return ctx.json({ secondStep: ["passkey"] });
};

export const secondFactorAfter = (db: D1Database) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === PASSKEY_SIGN_IN_PATH) {
      const created = ctx.context.newSession;
      if (failed(ctx) || !created) return;
      ctx.setCookie(ctx.context.createAuthCookie(PENDING_COOKIE).name, "", {
        maxAge: 0,
        path: "/",
      });
      await clearKey(db, await accountKey(created.user.email));
      await audit(db, {
        actor: "self",
        email: created.user.email,
        address: addressOfContext(ctx),
        event: "SignIn",
        outcome: "Succeeded",
      });
      return;
    }
    const address = addressOfContext(ctx);
    if (ctx.path === SIGN_IN_PATH) return afterSignIn(db, ctx, address);
    if (TWO_FACTOR_PATHS.has(ctx.path)) {
      const email = (await twoFactorPendingEmail(ctx)) ?? ctx.context.newSession?.user.email ?? "";
      if (failed(ctx)) {
        await audit(db, {
          actor: "anonymous",
          email,
          address,
          event: "SignIn",
          outcome: "Refused",
        });
        return;
      }
      await settleSuccess(db, address, await accountKey(email));
      await audit(db, { actor: "self", email, address, event: "SignIn", outcome: "Succeeded" });
      return;
    }
    if (ctx.path === RESET_PATH) {
      const email = stringField(ctx.body, "email") ?? "";
      if (failed(ctx)) {
        await audit(db, {
          actor: "anonymous",
          email,
          address,
          event: "PasswordReset",
          outcome: "Refused",
        });
        return;
      }
      await settleSuccess(db, address, await accountKey(email));
      await audit(db, {
        actor: "self",
        email,
        address,
        event: "PasswordReset",
        outcome: "Succeeded",
      });
    }
  });
