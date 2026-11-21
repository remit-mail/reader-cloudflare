import { WorkerEntrypoint, waitUntil } from "cloudflare:workers";
import type { PeopleAuditEvent, Person, PersonStatus } from "@remit/api-openapi-types";
import type {
  PeopleDirectory,
  PeopleOutcome,
  PeopleRequest,
  PersonRequest,
  TargetedRequest,
} from "@remit/auth-service/people";
import { PeopleErrorCode } from "@remit/domain-enums";
import { audit, auditRows, auditStatement } from "./audit";
import { createAuth } from "./auth";
import { mailerOf } from "./capture";
import { configOf, isOperator, normalizeEmail } from "./config";
import { randomId, randomToken, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { sendInvite } from "./mail";
import { issueInvite } from "./routes/app";

interface PersonRow {
  readonly id: string;
  readonly email: string;
  readonly created_at: number;
  readonly banned: number | null;
  readonly sessions: number;
  readonly last_sign_in: number | null;
}

const refused = <T>(
  refusal: "not_found" | (typeof PeopleErrorCode)[keyof typeof PeopleErrorCode],
): PeopleOutcome<T> => ({
  ok: false,
  refusal,
});

const person = (row: PersonRow, callerId: string): Person => ({
  userId: row.id,
  email: row.email,
  createdAt: row.created_at,
  lastSignInAt: row.last_sign_in ?? row.created_at,
  sessionCount: row.sessions,
  status: row.banned ? "Disabled" : "Active",
  isCaller: row.id === callerId,
});

const personRow = (db: D1Database, userId: string): Promise<PersonRow | null> =>
  db
    .prepare(
      `SELECT user.id, user.email, user.created_at, user.banned,
        (SELECT COUNT(*) FROM session WHERE session.user_id = user.id AND session.expires_at > ?2) AS sessions,
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = lower(user.email) AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user WHERE user.id = ?1`,
    )
    .bind(userId, Date.now())
    .first<PersonRow>();

const activeCaller = async (db: D1Database, request: PeopleRequest): Promise<boolean> => {
  const row = await db
    .prepare("SELECT id FROM user WHERE id = ? AND COALESCE(banned, 0) = 0")
    .bind(request.callerId)
    .first();
  return row !== null;
};

const callerEmail = async (db: D1Database, callerId: string): Promise<string> => {
  const row = await db.prepare("SELECT email FROM user WHERE id = ?").bind(callerId).first<{
    email: string;
  }>();
  if (row === null) throw new Error(`caller ${callerId} does not exist`);
  return row.email;
};

const target = async (env: Env, request: PersonRequest): Promise<PeopleOutcome<PersonRow>> => {
  if (!(await activeCaller(env.DB, request))) return refused(PeopleErrorCode.CallerDisabled);
  const row = await personRow(env.DB, request.targetId);
  if (row === null || (row.id !== request.callerId && isOperator(configOf(env), row.email))) {
    return refused("not_found");
  }
  return { ok: true, value: row };
};

const personAuditStatement = async (
  env: Env,
  request: PeopleRequest,
  email: string,
  event: "Disabled" | "Enabled" | "FactorReset" | "SignOutEverywhere" | "PasswordReset",
  at: number,
): Promise<D1PreparedStatement> =>
  auditStatement(
    env.DB,
    {
      actor: await callerEmail(env.DB, request.callerId),
      email,
      address: request.clientIp,
      event,
      outcome: "Succeeded",
      clientId: "api",
    },
    at,
  );

const guardedTarget = async (
  env: Env,
  request: TargetedRequest,
  status?: PersonStatus,
): Promise<PeopleOutcome<PersonRow>> => {
  if (!request.operatorGrant) return refused(PeopleErrorCode.StepUpRequired);
  if (status === "Disabled" && request.targetId === request.callerId) {
    return refused(PeopleErrorCode.CannotDisableSelf);
  }
  return target(env, request);
};

export const peopleAdmin = (env: Env): PeopleDirectory => ({
  listPeople: async (request) => {
    if (!(await activeCaller(env.DB, request))) return refused(PeopleErrorCode.CallerDisabled);
    const rows = await env.DB.prepare(
      `SELECT user.id, user.email, user.created_at, user.banned,
        (SELECT COUNT(*) FROM session WHERE session.user_id = user.id AND session.expires_at > ?1) AS sessions,
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = lower(user.email) AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user ORDER BY user.email`,
    )
      .bind(Date.now())
      .all<PersonRow>();
    return { ok: true, value: rows.results.map((row) => person(row, request.callerId)) };
  },

  listAudit: async (request) => {
    if (!(await activeCaller(env.DB, request))) return refused(PeopleErrorCode.CallerDisabled);
    const rows = await auditRows(env.DB, 90);
    return {
      ok: true,
      value: rows.map(
        (row): PeopleAuditEvent => ({
          auditEventId: row.auditEventId,
          occurredAt: row.at,
          actor: row.actor,
          target: row.email,
          action: row.event,
          outcome: row.outcome,
          clientIp: row.address,
        }),
      ),
    };
  },

  invitePerson: async (request) => {
    if (!(await activeCaller(env.DB, request))) return refused(PeopleErrorCode.CallerDisabled);
    const email = normalizeEmail(request.email);
    const existing = await env.DB.prepare("SELECT id FROM user WHERE lower(email) = ?")
      .bind(email)
      .first();
    if (existing !== null) return refused("not_found");
    const { inviteId, token } = await issueInvite(env.DB, email, request.callerId);
    const sent = await sendInvite(mailerOf(env), configOf(env), email, token);
    if (!sent.ok) {
      await env.DB.prepare(
        "UPDATE invite SET state = 'Revoked', state_changed_at = ? WHERE invite_id = ?",
      )
        .bind(Date.now(), inviteId)
        .run();
      throw new Error(`the invite was not sent: ${sent.reason}`);
    }
    await audit(env.DB, {
      actor: await callerEmail(env.DB, request.callerId),
      email,
      address: request.clientIp,
      event: "InviteIssued",
      outcome: "Succeeded",
      clientId: "api",
    });
    return { ok: true, value: { email } };
  },

  revokeInvite: async (request) => {
    if (!(await activeCaller(env.DB, request))) return refused(PeopleErrorCode.CallerDisabled);
    const email = normalizeEmail(request.email);
    const now = Date.now();
    const [revoked] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE invite SET state = 'Revoked', state_changed_at = ? WHERE email = ? AND state = 'Open'",
      ).bind(now, email),
      auditStatement(
        env.DB,
        {
          actor: await callerEmail(env.DB, request.callerId),
          email,
          address: request.clientIp,
          event: "InviteRevoked",
          outcome: "Succeeded",
          clientId: "api",
        },
        now,
        true,
      ),
    ]);
    if (revoked === undefined || revoked.meta.changes === 0) return refused("not_found");
    return { ok: true, value: { email } };
  },

  resetPersonFactors: async (request) => {
    const found = await target(env, request);
    if (!found.ok) return found;
    const row = found.value;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM two_factor WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM passkey WHERE user_id = ?").bind(row.id),
      env.DB.prepare("UPDATE user SET two_factor_enabled = 0, updated_at = ? WHERE id = ?").bind(
        now,
        row.id,
      ),
      env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
      await personAuditStatement(env, request, row.email, "FactorReset", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after resetting factors`);
    return { ok: true, value: person(updated, request.callerId) };
  },

  createStepUp: async () => refused("not_found"),

  signOutPerson: async (request) => {
    const found = await guardedTarget(env, request);
    if (!found.ok) return found;
    const row = found.value;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
      await personAuditStatement(env, request, row.email, "SignOutEverywhere", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after sign-out`);
    return { ok: true, value: person(updated, request.callerId) };
  },

  updatePerson: async (request) => {
    const found = await guardedTarget(env, request, request.status);
    if (!found.ok) return found;
    const row = found.value;
    const disabled = request.status === "Disabled";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE user SET banned = ?, updated_at = ? WHERE id = ?").bind(
        disabled ? 1 : 0,
        now,
        row.id,
      ),
      ...(disabled
        ? [
            env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
            env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
          ]
        : []),
      await personAuditStatement(env, request, row.email, disabled ? "Disabled" : "Enabled", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after status update`);
    return { ok: true, value: person(updated, request.callerId) };
  },

  createPasswordReset: async (request) => {
    const found = await guardedTarget(env, request);
    if (!found.ok) return found;
    const row = found.value;
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60_000;
    const token = randomToken();
    const context = await (await createAuth(env, waitUntil)).$context;
    const scrambledHash = await context.password.hash(randomToken());
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE reset_link SET state = 'Replaced', state_changed_at = ? WHERE user_id = ? AND state = 'Open'",
      ).bind(now, row.id),
      env.DB.prepare(
        "INSERT INTO reset_link (reset_link_id, user_id, email, token_hash, state, created_at, expires_at, state_changed_at) VALUES (?, ?, ?, ?, 'Open', ?, ?, ?)",
      ).bind(randomId(), row.id, row.email, await sha256Hex(token), now, expiresAt, now),
      env.DB.prepare(
        "UPDATE account SET password = ?, updated_at = ? WHERE user_id = ? AND provider_id = 'credential'",
      ).bind(scrambledHash, now, row.id),
      env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
      await personAuditStatement(env, request, row.email, "PasswordReset", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after password reset`);
    return {
      ok: true,
      value: {
        person: person(updated, request.callerId),
        resetUrl: `${configOf(env).loginOrigin}/reset/password#${token}`,
        expiresAt,
      },
    };
  },

  recordRefusal: (request) => {
    waitUntil(
      callerEmail(env.DB, request.callerId).then((actor) =>
        audit(env.DB, {
          actor,
          email: request.targetId,
          address: request.clientIp,
          event: "PeopleRequestRefused",
          outcome: "Refused",
          clientId: "api",
        }),
      ),
    );
  },
});

export class PeopleAdmin extends WorkerEntrypoint<Env> {
  listPeople(...args: Parameters<PeopleDirectory["listPeople"]>) {
    return peopleAdmin(this.env).listPeople(...args);
  }

  listAudit(...args: Parameters<PeopleDirectory["listAudit"]>) {
    return peopleAdmin(this.env).listAudit(...args);
  }

  invitePerson(...args: Parameters<PeopleDirectory["invitePerson"]>) {
    return peopleAdmin(this.env).invitePerson(...args);
  }

  revokeInvite(...args: Parameters<PeopleDirectory["revokeInvite"]>) {
    return peopleAdmin(this.env).revokeInvite(...args);
  }

  resetPersonFactors(...args: Parameters<PeopleDirectory["resetPersonFactors"]>) {
    return peopleAdmin(this.env).resetPersonFactors(...args);
  }

  createStepUp(...args: Parameters<PeopleDirectory["createStepUp"]>) {
    return peopleAdmin(this.env).createStepUp(...args);
  }

  signOutPerson(...args: Parameters<PeopleDirectory["signOutPerson"]>) {
    return peopleAdmin(this.env).signOutPerson(...args);
  }

  updatePerson(...args: Parameters<PeopleDirectory["updatePerson"]>) {
    return peopleAdmin(this.env).updatePerson(...args);
  }

  createPasswordReset(...args: Parameters<PeopleDirectory["createPasswordReset"]>) {
    return peopleAdmin(this.env).createPasswordReset(...args);
  }

  recordRefusal(...args: Parameters<PeopleDirectory["recordRefusal"]>) {
    return peopleAdmin(this.env).recordRefusal(...args);
  }
}
