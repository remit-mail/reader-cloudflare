import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";
import { audit } from "../audit";
import type { AuthDeps } from "../auth";
import {
  accountKey,
  addressKey,
  addressOf,
  clearKey,
  refundKey,
  reserveAttempt,
  takeResetQuota,
} from "../backoff";
import { type LoginConfig, normalizeEmail } from "../config";
import { randomId, randomToken, sameHash, sha256Hex } from "../crypto";
import { json } from "../http";
import { log } from "../log";
import { type SendOutcome, sendInvite, sendResetLink } from "../mail";
import { PENDING_COOKIE, PENDING_SECONDS, TWO_FACTOR_COOKIE } from "../second-factor";
import { passkeyCount } from "../webauthn";
import { issueInvite } from "./app";

export const RESET_LINK_LIFE_MS = 60 * 60_000;
export const RESET_PASSWORD_PATH = "/app/reset/password";

export const RESET_ACCEPTED = {
  message: "If that address has an account, a link is on its way. It works once, for 1 hour.",
};

export const FRESH_LINK_ACCEPTED = {
  message: "If this link can be renewed, a fresh one is on its way to the address it was sent to.",
};

const DEAD_LINK = "This link no longer works. Email yourself a fresh one.";

const tokenOf = (body: unknown): string | null => {
  const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(body);
  return parsed.success ? parsed.data.token : null;
};

const backoffResponse = (until: number): Response =>
  json(429, {
    message: "Too many attempts. Try again later.",
    retryAt: new Date(until).toISOString(),
  });

const deadLink = (): Response => json(410, { message: DEAD_LINK, code: "LINK_DEAD" });

interface ActiveUser {
  readonly id: string;
  readonly email: string;
}

const activeUserByEmail = (db: D1Database, email: string): Promise<ActiveUser | null> =>
  db
    .prepare("SELECT id, email FROM user WHERE email = ? AND COALESCE(banned, 0) = 0")
    .bind(email)
    .first<ActiveUser>();

export const issueResetLink = async (
  db: D1Database,
  user: ActiveUser,
  now: number,
): Promise<string> => {
  const token = randomToken();
  await db.batch([
    db
      .prepare(
        "UPDATE reset_link SET state = 'Replaced', state_changed_at = ? WHERE user_id = ? AND state = 'Open'",
      )
      .bind(now, user.id),
    db
      .prepare(
        "INSERT INTO reset_link (reset_link_id, user_id, email, token_hash, state, created_at, expires_at, state_changed_at) VALUES (?, ?, ?, ?, 'Open', ?, ?, ?)",
      )
      .bind(
        randomId(),
        user.id,
        user.email,
        await sha256Hex(token),
        now,
        now + RESET_LINK_LIFE_MS,
        now,
      ),
  ]);
  return token;
};

const warnRefused = (what: string) => (sent: SendOutcome) => {
  if (!sent.ok) log.warn(`${what} email refused`, { reason: sent.reason });
};

const mailResetLink = async (
  db: D1Database,
  email: SendEmail,
  config: LoginConfig,
  user: ActiveUser,
  now: number,
): Promise<void> => {
  const token = await issueResetLink(db, user, now);
  await sendResetLink(email, config, user.email, token).then(warnRefused("reset link"));
};

const inBackground = (
  waitUntil: (promise: Promise<unknown>) => void,
  what: string,
  work: () => Promise<void>,
): void => {
  waitUntil(
    work().catch((error: unknown) => {
      log.error(`${what} failed`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }),
  );
};

export interface MailDeps {
  readonly db: D1Database;
  readonly config: LoginConfig;
  readonly email: SendEmail;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export const requestReset = (deps: MailDeps, request: Request, body: unknown): Response => {
  const parsed = z.object({ email: z.string().max(320) }).safeParse(body);
  const address = addressOf(request);
  if (parsed.success) {
    const email = normalizeEmail(parsed.data.email);
    inBackground(deps.waitUntil, "reset request", async () => {
      const now = Date.now();
      if (!(await takeResetQuota(deps.db, address, email, now))) return;
      await audit(deps.db, {
        actor: "anonymous",
        email,
        address,
        event: "ResetRequested",
        outcome: "Succeeded",
      });
      const user = await activeUserByEmail(deps.db, email);
      if (user === null) return;
      await mailResetLink(deps.db, deps.email, deps.config, user, now);
    });
  }
  return json(202, RESET_ACCEPTED);
};

interface InviteRow {
  readonly email: string;
  readonly state: "Open" | "Redeemed" | "Replaced" | "Revoked";
  readonly issued_by: string;
}

const renew = async (deps: MailDeps, tokenHash: string, address: string): Promise<void> => {
  const { db } = deps;
  const now = Date.now();
  const invite = await db
    .prepare("SELECT email, state, issued_by FROM invite WHERE token_hash = ?")
    .bind(tokenHash)
    .first<InviteRow>();
  const link =
    invite === null
      ? await db
          .prepare("SELECT email FROM reset_link WHERE token_hash = ?")
          .bind(tokenHash)
          .first<{ email: string }>()
      : null;
  const email = invite?.email ?? link?.email ?? null;
  if (!(await takeResetQuota(db, address, email, now))) return;
  await audit(db, {
    actor: "anonymous",
    email: email ?? "",
    address,
    event: "FreshLinkRequested",
    outcome: email === null ? "Refused" : "Succeeded",
  });
  if (email === null) return;
  const account = await db
    .prepare("SELECT id, email, COALESCE(banned, 0) AS banned FROM user WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; banned: number }>();
  if (account !== null && account.banned !== 0) return;
  if (invite !== null) {
    const newest = await db
      .prepare("SELECT state FROM invite WHERE email = ? ORDER BY created_at DESC LIMIT 1")
      .bind(email)
      .first<{ state: InviteRow["state"] }>();
    if (invite.state === "Revoked" || newest?.state === "Revoked") return;
  }
  if (account !== null) {
    await mailResetLink(db, deps.email, deps.config, account, now);
    return;
  }
  if (invite === null) return;
  const { token } = await issueInvite(db, email, invite.issued_by);
  await sendInvite(deps.email, deps.config, email, token).then(warnRefused("fresh invite"));
};

export const requestFreshLink = async (
  deps: MailDeps,
  request: Request,
  body: unknown,
): Promise<Response> => {
  const address = addressOf(request);
  const token = tokenOf(body);
  const tokenHash = token === null ? null : await sha256Hex(token);
  inBackground(deps.waitUntil, "fresh link request", async () => {
    if (tokenHash === null) {
      await takeResetQuota(deps.db, address, null, Date.now());
      return;
    }
    await renew(deps, tokenHash, address);
  });
  return json(202, FRESH_LINK_ACCEPTED);
};

const OPEN_LINK =
  "SELECT reset_link.email AS email, reset_link.token_hash AS token_hash FROM reset_link JOIN user ON user.id = reset_link.user_id WHERE reset_link.token_hash = ? AND reset_link.state = 'Open' AND reset_link.expires_at > ? AND COALESCE(user.banned, 0) = 0";

const openLink = async (
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<{ email: string } | null> => {
  const row = await db
    .prepare(OPEN_LINK)
    .bind(tokenHash, now)
    .first<{ email: string; token_hash: string }>();
  return row !== null && sameHash(row.token_hash, tokenHash) ? { email: row.email } : null;
};

export const lookupResetLink = async (
  db: D1Database,
  request: Request,
  body: unknown,
): Promise<Response> => {
  const address = addressOf(request);
  const now = Date.now();
  const reservation = await reserveAttempt(db, [addressKey(address)], now);
  if (!reservation.allowed) return backoffResponse(reservation.retryAt);
  const token = tokenOf(body);
  if (token === null) return deadLink();
  const link = await openLink(db, await sha256Hex(token), now);
  if (link === null) return deadLink();
  await refundKey(db, addressKey(address));
  return json(200, { email: link.email });
};

const resetBody = z.object({ token: z.string().min(1).max(200), password: z.string() });

export type SecondStepAfterReset = "app" | "passkey" | "none";

export const resetEndpoints = (deps: AuthDeps) => {
  const { db } = deps;
  return {
    id: "login-reset",
    endpoints: {
      resetPassword: createAuthEndpoint(
        RESET_PASSWORD_PATH,
        { method: "POST", body: resetBody, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const address = addressOf({ headers: ctx.headers ?? new Headers() });
          const now = Date.now();
          const reservation = await reserveAttempt(db, [addressKey(address)], now);
          if (!reservation.allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many attempts. Try again later.",
              code: "BACKOFF",
              retryAt: new Date(reservation.retryAt).toISOString(),
            });
          }
          const dead = new APIError("GONE", { message: DEAD_LINK, code: "LINK_DEAD" });
          const tokenHash = await sha256Hex(ctx.body.token);
          if ((await openLink(db, tokenHash, now)) === null) throw dead;
          const { password } = ctx.body;
          if (password.length < 12 || password.length > 128) {
            throw new APIError("BAD_REQUEST", {
              message: "Choose a password of 12 to 128 characters.",
              code: "PASSWORD_LENGTH",
            });
          }
          const hash = await ctx.context.password.hash(password);
          const used = await db
            .prepare(
              "UPDATE reset_link SET state = 'Used', state_changed_at = ?1 WHERE token_hash = ?2 AND state = 'Open' AND expires_at > ?1 RETURNING user_id, token_hash",
            )
            .bind(Date.now(), tokenHash)
            .first<{ user_id: string; token_hash: string }>();
          if (used === null || !sameHash(used.token_hash, tokenHash)) throw dead;
          const active = await db
            .prepare("SELECT id FROM user WHERE id = ? AND COALESCE(banned, 0) = 0")
            .bind(used.user_id)
            .first();
          const user =
            active === null ? null : await ctx.context.internalAdapter.findUserById(used.user_id);
          if (user === null) throw dead;
          const credential = (await ctx.context.internalAdapter.findAccounts(user.id)).find(
            (account) => account.providerId === "credential",
          );
          if (credential) await ctx.context.internalAdapter.updatePassword(user.id, hash);
          else {
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: hash,
            });
          }
          await db.batch([
            db.prepare("DELETE FROM session WHERE user_id = ?").bind(user.id),
            db.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(user.id),
          ]);
          await refundKey(db, addressKey(address));
          await clearKey(db, await accountKey(user.email));
          await audit(db, {
            actor: "self",
            email: user.email,
            address,
            event: "PasswordReset",
            outcome: "Succeeded",
          });
          const app = await db
            .prepare(
              "SELECT two_factor.id FROM two_factor JOIN user ON user.id = two_factor.user_id WHERE two_factor.user_id = ? AND user.two_factor_enabled = 1 AND COALESCE(two_factor.verified, 1) != 0",
            )
            .bind(user.id)
            .first();
          if (app !== null) {
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, {
              maxAge: PENDING_SECONDS,
            });
            const identifier = `2fa-${generateRandomString(20)}`;
            const expiresAt = new Date(Date.now() + PENDING_SECONDS * 1000);
            await ctx.context.internalAdapter.createVerificationValue({
              value: user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: "0",
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            );
            return ctx.json({ secondStep: "app" satisfies SecondStepAfterReset });
          }
          if ((await passkeyCount(db, user.id)) > 0) {
            const cookie = ctx.context.createAuthCookie(PENDING_COOKIE, {
              maxAge: PENDING_SECONDS,
            });
            await ctx.setSignedCookie(
              cookie.name,
              `${user.id}|${Date.now() + PENDING_SECONDS * 1000}`,
              ctx.context.secret,
              cookie.attributes,
            );
            return ctx.json({ secondStep: "passkey" satisfies SecondStepAfterReset });
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ secondStep: "none" satisfies SecondStepAfterReset });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};
