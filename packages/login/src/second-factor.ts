import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { audit } from "./audit";
import {
  type AttemptKey,
  accountKey,
  addressKey,
  addressOf,
  clearKey,
  firstDelay,
  recordFailure,
  retryAt,
} from "./backoff";

type MiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const PENDING_COOKIE = "pending_second_step";
const PENDING_SECONDS = 600;
const TWO_FACTOR_COOKIE = "two_factor";

export const SIGN_IN_PATH = "/sign-in/email";
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";
export const TWO_FACTOR_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);
export const RESET_PATH = "/email-otp/reset-password";

const headersOf = (ctx: MiddlewareContext): Headers => ctx.headers ?? new Headers();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (body: unknown, name: string): string | undefined => {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === "string" ? value : undefined;
};

export const failed = (ctx: MiddlewareContext): boolean => ctx.context.returned instanceof APIError;

export const tooManyAttempts = (until: number): APIError =>
  new APIError("TOO_MANY_REQUESTS", {
    message: "Too many attempts. Try again later.",
    code: "BACKOFF",
    retryAt: new Date(until).toISOString(),
  });

export const refuseWhileDelayed = async (
  db: D1Database,
  keys: readonly AttemptKey[],
): Promise<void> => {
  const until = await retryAt(db, keys, Date.now());
  if (until !== null) throw tooManyAttempts(until);
};

export const countFailure = async (
  db: D1Database,
  keys: readonly AttemptKey[],
  email: string,
  address: string,
): Promise<void> => {
  const outcomes = await recordFailure(db, keys, Date.now());
  if (firstDelay(outcomes)) {
    await audit(db, { actor: "anonymous", email, address, event: "Backoff", outcome: "Refused" });
  }
};

const keysFor = async (email: string, address: string): Promise<AttemptKey[]> => [
  addressKey(address),
  await accountKey(email),
];

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
    const address = addressOf({ headers: headersOf(ctx) });
    if (ctx.path === SIGN_IN_PATH || ctx.path === RESET_PATH) {
      const email = stringField(ctx.body, "email") ?? "";
      await refuseWhileDelayed(db, await keysFor(email, address));
      return;
    }
    if (TWO_FACTOR_PATHS.has(ctx.path)) {
      if (isRecord(ctx.body) && ctx.body.trustDevice === true) {
        throw new APIError("BAD_REQUEST", { message: "Trusted devices are not offered." });
      }
      const email = await twoFactorPendingEmail(ctx);
      await refuseWhileDelayed(db, email ? await keysFor(email, address) : [addressKey(address)]);
      return;
    }
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
    }
  });

const hasPasskey = async (ctx: MiddlewareContext, userId: string): Promise<boolean> => {
  const count = await ctx.context.adapter.count({
    model: "passkey",
    where: [{ field: "userId", value: userId }],
  });
  return count > 0;
};

const afterSignIn = async (db: D1Database, ctx: MiddlewareContext, address: string) => {
  const email = stringField(ctx.body, "email") ?? "";
  if (failed(ctx)) {
    await countFailure(db, await keysFor(email, address), email, address);
    await audit(db, { actor: "anonymous", email, address, event: "SignIn", outcome: "Refused" });
    return;
  }
  const created = ctx.context.newSession;
  if (!created) return;
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
  if (!(await hasPasskey(ctx, created.user.id))) {
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
    const address = addressOf({ headers: headersOf(ctx) });
    if (ctx.path === SIGN_IN_PATH) return afterSignIn(db, ctx, address);
    if (TWO_FACTOR_PATHS.has(ctx.path)) {
      const email = (await twoFactorPendingEmail(ctx)) ?? ctx.context.newSession?.user.email ?? "";
      if (failed(ctx)) {
        await countFailure(db, await keysFor(email, address), email, address);
        await audit(db, {
          actor: "anonymous",
          email,
          address,
          event: "SignIn",
          outcome: "Refused",
        });
        return;
      }
      if (email) await clearKey(db, await accountKey(email));
      await audit(db, { actor: "self", email, address, event: "SignIn", outcome: "Succeeded" });
      return;
    }
    if (ctx.path === PASSKEY_SIGN_IN_PATH) {
      if (failed(ctx)) return;
      const created = ctx.context.newSession;
      if (!created) return;
      ctx.setCookie(ctx.context.createAuthCookie(PENDING_COOKIE).name, "", {
        maxAge: 0,
        path: "/",
      });
      await clearKey(db, await accountKey(created.user.email));
      await audit(db, {
        actor: "self",
        email: created.user.email,
        address,
        event: "SignIn",
        outcome: "Succeeded",
      });
      return;
    }
    if (ctx.path === RESET_PATH) {
      const email = stringField(ctx.body, "email") ?? "";
      if (failed(ctx)) {
        await countFailure(db, await keysFor(email, address), email, address);
        await audit(db, {
          actor: "anonymous",
          email,
          address,
          event: "PasswordReset",
          outcome: "Refused",
        });
        return;
      }
      await clearKey(db, await accountKey(email));
      await audit(db, {
        actor: "self",
        email,
        address,
        event: "PasswordReset",
        outcome: "Succeeded",
      });
    }
  });
