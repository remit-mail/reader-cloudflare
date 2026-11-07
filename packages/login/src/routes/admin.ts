import { z } from "zod";
import {
  type AdminUser,
  adminPage,
  auditPage,
  enrollPage,
  toResponse,
  type UserState,
} from "../admin-page";
import { type AuditEntry, auditRows, auditStatement } from "../audit";
import type { Auth } from "../auth";
import { accountKey, addressKey, addressOf, retryAt } from "../backoff";
import { isOperator, type LoginConfig, normalizeEmail } from "../config";
import { notFound } from "../http";
import { sendInvite } from "../mail";
import { countFailure } from "../second-factor";
import {
  type AdminAction,
  type Binding,
  consumeChallenge,
  isAdminAction,
  KEY_ACTIONS,
  loadOperatorFactors,
  type Operator,
  openChallenge,
  type Proof,
  stepUpMethodOf,
  verifyProof,
} from "../step-up";
import { issueInvite, revokeInvite } from "./app";

export interface AdminContext {
  readonly auth: Auth;
  readonly config: LoginConfig;
  readonly db: D1Database;
  readonly email: SendEmail;
}

interface OperatorSession {
  readonly operator: Operator;
  readonly sessionId: string;
}

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const operatorSession = async (
  context: AdminContext,
  request: Request,
): Promise<OperatorSession | null> => {
  const found = await context.auth.api.getSession({ headers: request.headers });
  if (!found) return null;
  const { user, session } = found;
  if ((user as { banned?: boolean | null }).banned) return null;
  if (!isOperator(context.config, user.email)) return null;
  return {
    operator: await loadOperatorFactors(context.db, user.id, normalizeEmail(user.email)),
    sessionId: session.id,
  };
};

interface UserListRow {
  email: string;
  banned: number | null;
  two_factor_enabled: number | null;
  passkeys: number;
  sessions: number;
  last_sign_in: number | null;
}

const listUsers = async (db: D1Database, now: number): Promise<AdminUser[]> => {
  const users = await db
    .prepare(
      `SELECT user.email AS email, user.banned AS banned, user.two_factor_enabled AS two_factor_enabled,
        (SELECT COUNT(*) FROM passkey WHERE passkey.user_id = user.id) AS passkeys,
        (SELECT COUNT(*) FROM session WHERE session.user_id = user.id AND session.expires_at > ?1) AS sessions,
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = lower(user.email) AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user ORDER BY user.email`,
    )
    .bind(now)
    .all<UserListRow>();
  const invited = await db
    .prepare(
      "SELECT DISTINCT email FROM invite WHERE state = 'Open' AND expires_at > ? AND email NOT IN (SELECT lower(email) FROM user) ORDER BY email",
    )
    .bind(now)
    .all<{ email: string }>();
  const stateOf = (row: UserListRow): UserState => (row.banned ? "disabled" : "active");
  return [
    ...users.results.map((row) => ({
      email: row.email,
      state: stateOf(row),
      passkeys: row.passkeys,
      app: Boolean(row.two_factor_enabled),
      sessions: row.sessions,
      lastSignIn: row.last_sign_in,
    })),
    ...invited.results.map((row) => ({
      email: row.email,
      state: "invited" as const,
      passkeys: 0,
      app: false,
      sessions: 0,
      lastSignIn: null,
    })),
  ];
};

export const renderAdmin = async (context: AdminContext, request: Request): Promise<Response> => {
  const session = await operatorSession(context, request);
  if (session === null) return notFound();
  if (stepUpMethodOf(session.operator) === null) return toResponse(enrollPage());
  return toResponse(
    adminPage(session.operator.email, await listUsers(context.db, Date.now()), (email) =>
      isOperator(context.config, email),
    ),
  );
};

export const renderAudit = async (context: AdminContext, request: Request): Promise<Response> => {
  const session = await operatorSession(context, request);
  if (session === null) return notFound();
  if (stepUpMethodOf(session.operator) === null) return toResponse(enrollPage());
  const requested = Number(new URL(request.url).searchParams.get("days") ?? "7");
  const days = Number.isInteger(requested) ? Math.min(90, Math.max(1, requested)) : 7;
  return toResponse(auditPage(days, await auditRows(context.db, days)));
};

const challengeBody = z.object({
  action: z.string(),
  targetEmail: z.string().max(320),
});

const actionBody = z.object({
  adminChallengeId: z.string().max(64),
  action: z.string(),
  targetEmail: z.string().max(320),
  assertion: z.unknown().optional(),
  totpCode: z.string().max(12).optional(),
});

type TargetCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const checkTarget = (
  config: LoginConfig,
  operator: Operator,
  action: AdminAction,
  targetEmail: string,
): TargetCheck => {
  if (KEY_ACTIONS.has(action)) {
    return targetEmail === operator.email
      ? { ok: true }
      : { ok: false, message: "Key actions name your own email as their target." };
  }
  if (!z.email().safeParse(targetEmail).success) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (action !== "Invite" && isOperator(config, targetEmail)) {
    return {
      ok: false,
      message:
        "Operators cannot act on an operator account. Change operator_emails in the deploy config instead.",
    };
  }
  return { ok: true };
};

const AUDIT_EVENT: Readonly<Record<AdminAction, AuditEntry["event"]>> = {
  Invite: "InviteIssued",
  Disable: "Disabled",
  Enable: "Enabled",
  ResetFactors: "FactorReset",
  SignOutEverywhere: "SignOutEverywhere",
  RotateKeys: "KeysRotated",
  RevokeKeys: "KeysRotated",
};

const refuse = async (
  context: AdminContext,
  operator: Operator,
  action: AdminAction,
  targetEmail: string,
  address: string,
  message: string,
): Promise<Response> => {
  await auditStatement(
    context.db,
    {
      actor: operator.email,
      email: targetEmail,
      address,
      event: AUDIT_EVENT[action],
      outcome: "Refused",
    },
    Date.now(),
  ).run();
  return json(403, { message });
};

export const openAdminChallenge = async (
  context: AdminContext,
  request: Request,
  body: unknown,
): Promise<Response> => {
  const session = await operatorSession(context, request);
  if (session === null) return notFound();
  const { operator } = session;
  if (stepUpMethodOf(operator) === null) {
    return json(403, {
      message: "Add a passkey or an authenticator app on the Security page first.",
    });
  }
  const parsed = challengeBody.safeParse(body);
  if (!parsed.success || !isAdminAction(parsed.data.action)) {
    return json(400, { message: "Unknown admin action." });
  }
  const action = parsed.data.action;
  const targetEmail = normalizeEmail(parsed.data.targetEmail);
  const address = addressOf(request);
  const target = checkTarget(context.config, operator, action, targetEmail);
  if (!target.ok) return refuse(context, operator, action, targetEmail, address, target.message);
  const keys = [addressKey(address), await accountKey(operator.email)];
  const until = await retryAt(context.db, keys, Date.now());
  if (until !== null) {
    return json(429, {
      message: "Too many failed confirmations. Try again later.",
      retryAt: new Date(until).toISOString(),
    });
  }
  const opened = await openChallenge(
    context.db,
    context.config,
    operator,
    { operatorUserId: operator.userId, sessionId: session.sessionId, action, targetEmail },
    Date.now(),
  );
  if (opened === null) {
    return json(403, {
      message: "Add a passkey or an authenticator app on the Security page first.",
    });
  }
  return json(200, opened);
};

type Outcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly status: number; readonly message: string };

const userIdOf = (db: D1Database, email: string) =>
  db
    .prepare("SELECT id, banned FROM user WHERE lower(email) = ?")
    .bind(email)
    .first<{ id: string; banned: number | null }>();

const runAction = async (
  context: AdminContext,
  operator: Operator,
  action: AdminAction,
  targetEmail: string,
  entry: AuditEntry,
): Promise<Outcome> => {
  const { db } = context;
  const now = Date.now();
  const audited = auditStatement(db, entry, now);
  if (action === "Invite") {
    if ((await userIdOf(db, targetEmail)) !== null) {
      return { ok: false, status: 409, message: `${targetEmail} already has an account.` };
    }
    const { inviteId, token } = await issueInvite(db, targetEmail, operator.email);
    const sent = await sendInvite(context.email, context.config, targetEmail, token);
    if (!sent.ok) {
      await revokeInvite(db, inviteId);
      await auditStatement(db, { ...entry, outcome: "Refused" }, now).run();
      return { ok: false, status: 502, message: `The invite was not sent: ${sent.reason}` };
    }
    await audited.run();
    return { ok: true, message: `Invited ${targetEmail}.` };
  }
  if (action === "RotateKeys") {
    await db.batch([
      db
        .prepare("UPDATE jwks SET expires_at = ?1 WHERE expires_at IS NULL OR expires_at > ?1")
        .bind(now),
      audited,
    ]);
    return { ok: true, message: "A new signing key starts with the next sign-in." };
  }
  if (action === "RevokeKeys") {
    await db.batch([
      db.prepare("DELETE FROM jwks"),
      db.prepare("DELETE FROM session"),
      db.prepare("DELETE FROM oauth_access_token"),
      audited,
    ]);
    return { ok: true, message: "Every signing key and every session is gone." };
  }
  const target = await userIdOf(db, targetEmail);
  if (target === null) return { ok: false, status: 404, message: `${targetEmail} has no account.` };
  const endSessions = [
    db.prepare("DELETE FROM session WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(target.id),
  ];
  if (action === "Disable") {
    await db.batch([
      db.prepare("UPDATE user SET banned = 1, updated_at = ? WHERE id = ?").bind(now, target.id),
      ...endSessions,
      audited,
    ]);
    return { ok: true, message: `Disabled ${targetEmail}.` };
  }
  if (action === "Enable") {
    if (!target.banned)
      return { ok: false, status: 409, message: `${targetEmail} is not disabled.` };
    await db.batch([
      db.prepare("UPDATE user SET banned = 0, updated_at = ? WHERE id = ?").bind(now, target.id),
      audited,
    ]);
    return { ok: true, message: `Enabled ${targetEmail}.` };
  }
  if (action === "ResetFactors") {
    await db.batch([
      db.prepare("DELETE FROM two_factor WHERE user_id = ?").bind(target.id),
      db.prepare("DELETE FROM passkey WHERE user_id = ?").bind(target.id),
      db
        .prepare("UPDATE user SET two_factor_enabled = 0, updated_at = ? WHERE id = ?")
        .bind(now, target.id),
      ...endSessions,
      audited,
    ]);
    return { ok: true, message: `Reset the factors of ${targetEmail}.` };
  }
  await db.batch([...endSessions, audited]);
  return { ok: true, message: `Signed ${targetEmail} out everywhere.` };
};

export const runAdminAction = async (
  context: AdminContext,
  request: Request,
  body: unknown,
): Promise<Response> => {
  const session = await operatorSession(context, request);
  if (session === null) return notFound();
  const { operator } = session;
  if (stepUpMethodOf(operator) === null) {
    return json(403, {
      message: "Add a passkey or an authenticator app on the Security page first.",
    });
  }
  const parsed = actionBody.safeParse(body);
  if (!parsed.success || !isAdminAction(parsed.data.action)) {
    return json(400, { message: "Unknown admin action." });
  }
  const { adminChallengeId, assertion, totpCode } = parsed.data;
  const action = parsed.data.action;
  const targetEmail = normalizeEmail(parsed.data.targetEmail);
  const address = addressOf(request);
  const target = checkTarget(context.config, operator, action, targetEmail);
  if (!target.ok) return refuse(context, operator, action, targetEmail, address, target.message);
  const keys = [addressKey(address), await accountKey(operator.email)];
  const now = Date.now();
  const until = await retryAt(context.db, keys, now);
  if (until !== null) {
    return json(429, {
      message: "Too many failed confirmations. Try again later.",
      retryAt: new Date(until).toISOString(),
    });
  }
  const binding: Binding = {
    operatorUserId: operator.userId,
    sessionId: session.sessionId,
    action,
    targetEmail,
  };
  const consumed = await consumeChallenge(context.db, adminChallengeId, binding, now);
  if (consumed === null) {
    return json(403, {
      message: "This confirmation expired or belongs to another action. Try again.",
    });
  }
  const proof: Proof | null =
    totpCode !== undefined
      ? { kind: "Totp", code: totpCode }
      : assertion !== undefined
        ? { kind: "Passkey", assertion }
        : null;
  const authContext = await context.auth.$context;
  const verified =
    proof !== null &&
    (await verifyProof(
      context.db,
      context.config,
      authContext.secretConfig,
      operator,
      consumed,
      adminChallengeId,
      proof,
      now,
    ));
  const stepUp: AuditEntry = {
    actor: operator.email,
    email: targetEmail,
    address,
    event: "AdminStepUp",
    outcome: verified ? "Succeeded" : "Refused",
  };
  await auditStatement(context.db, stepUp, now).run();
  if (!verified) {
    await countFailure(context.db, keys, operator.email, address);
    return json(403, { message: "The confirmation did not verify. Nothing was changed." });
  }
  const outcome = await runAction(context, operator, action, targetEmail, {
    actor: operator.email,
    email: targetEmail,
    address,
    event: AUDIT_EVENT[action],
    outcome: "Succeeded",
  });
  if (!outcome.ok) return json(outcome.status, { message: outcome.message });
  return json(200, { message: outcome.message });
};
