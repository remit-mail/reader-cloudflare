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

interface Caller {
  readonly id: string;
  readonly email: string;
}

const person = (row: PersonRow, caller: Caller): Person => ({
  userId: row.id,
  email: row.email,
  createdAt: row.created_at,
  lastSignInAt: row.last_sign_in ?? row.created_at,
  sessionCount: row.sessions,
  status: row.banned ? "Disabled" : "Active",
  isCaller: row.id === caller.id,
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

// callerId carries the caller's email, the one identity the app Worker and the
// login Worker share.
const activeCaller = (db: D1Database, request: PeopleRequest): Promise<Caller | null> =>
  db
    .prepare("SELECT id, email FROM user WHERE email = ? AND COALESCE(banned, 0) = 0")
    .bind(normalizeEmail(request.callerId))
    .first<Caller>();

interface Target {
  readonly caller: Caller;
  readonly row: PersonRow;
}

const target = async (env: Env, request: PersonRequest): Promise<PeopleOutcome<Target>> => {
  const caller = await activeCaller(env.DB, request);
  if (caller === null) return refused(PeopleErrorCode.CallerDisabled);
  const row = await personRow(env.DB, request.targetId);
  if (row === null || (row.id !== caller.id && isOperator(configOf(env), row.email))) {
    return refused("not_found");
  }
  return { ok: true, value: { caller, row } };
};

const personAuditStatement = (
  env: Env,
  request: PeopleRequest,
  caller: Caller,
  email: string,
  event: "Disabled" | "Enabled" | "FactorReset" | "SignOutEverywhere" | "PasswordReset",
  at: number,
): D1PreparedStatement =>
  auditStatement(
    env.DB,
    {
      actor: caller.email,
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
): Promise<PeopleOutcome<Target>> => {
  if (!request.operatorGrant) return refused(PeopleErrorCode.StepUpRequired);
  const found = await target(env, request);
  if (found.ok && status === "Disabled" && found.value.row.id === found.value.caller.id) {
    return refused(PeopleErrorCode.CannotDisableSelf);
  }
  return found;
};

export const peopleAdmin = (env: Env): PeopleDirectory => ({
  listPeople: async (request) => {
    const caller = await activeCaller(env.DB, request);
    if (caller === null) return refused(PeopleErrorCode.CallerDisabled);
    const rows = await env.DB.prepare(
      `SELECT user.id, user.email, user.created_at, user.banned,
        (SELECT COUNT(*) FROM session WHERE session.user_id = user.id AND session.expires_at > ?1) AS sessions,
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = lower(user.email) AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user ORDER BY user.email`,
    )
      .bind(Date.now())
      .all<PersonRow>();
    return { ok: true, value: rows.results.map((row) => person(row, caller)) };
  },

  listAudit: async (request) => {
    if ((await activeCaller(env.DB, request)) === null) {
      return refused(PeopleErrorCode.CallerDisabled);
    }
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
    const caller = await activeCaller(env.DB, request);
    if (caller === null) return refused(PeopleErrorCode.CallerDisabled);
    const email = normalizeEmail(request.email);
    const existing = await env.DB.prepare("SELECT id FROM user WHERE lower(email) = ?")
      .bind(email)
      .first();
    if (existing !== null) return refused("not_found");
    const { inviteId, token } = await issueInvite(env.DB, email, caller.id);
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
      actor: caller.email,
      email,
      address: request.clientIp,
      event: "InviteIssued",
      outcome: "Succeeded",
      clientId: "api",
    });
    return { ok: true, value: { email } };
  },

  revokeInvite: async (request) => {
    const caller = await activeCaller(env.DB, request);
    if (caller === null) return refused(PeopleErrorCode.CallerDisabled);
    const email = normalizeEmail(request.email);
    const now = Date.now();
    const [revoked] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE invite SET state = 'Revoked', state_changed_at = ? WHERE email = ? AND state = 'Open'",
      ).bind(now, email),
      auditStatement(
        env.DB,
        {
          actor: caller.email,
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
    const { caller, row } = found.value;
    const now = Date.now();
    await env.OPERATOR_SETTINGS.revokePersonCredentials(row.email, false);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM two_factor WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM passkey WHERE user_id = ?").bind(row.id),
      env.DB.prepare("UPDATE user SET two_factor_enabled = 0, updated_at = ? WHERE id = ?").bind(
        now,
        row.id,
      ),
      env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
      personAuditStatement(env, request, caller, row.email, "FactorReset", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after resetting factors`);
    return { ok: true, value: person(updated, caller) };
  },

  createStepUp: async () => refused("not_found"),

  signOutPerson: async (request) => {
    const found = await guardedTarget(env, request);
    if (!found.ok) return found;
    const { caller, row } = found.value;
    const now = Date.now();
    await env.OPERATOR_SETTINGS.revokePersonCredentials(row.email, false);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
      personAuditStatement(env, request, caller, row.email, "SignOutEverywhere", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after sign-out`);
    return { ok: true, value: person(updated, caller) };
  },

  updatePerson: async (request) => {
    const found = await guardedTarget(env, request, request.status);
    if (!found.ok) return found;
    const { caller, row } = found.value;
    const disabled = request.status === "Disabled";
    const now = Date.now();
    if (disabled) await env.OPERATOR_SETTINGS.revokePersonCredentials(row.email, true);
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
      personAuditStatement(env, request, caller, row.email, disabled ? "Disabled" : "Enabled", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after status update`);
    return { ok: true, value: person(updated, caller) };
  },

  createPasswordReset: async (request) => {
    const found = await guardedTarget(env, request);
    if (!found.ok) return found;
    const { caller, row } = found.value;
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60_000;
    const token = randomToken();
    const context = await (await createAuth(env, waitUntil)).$context;
    const scrambledHash = await context.password.hash(randomToken());
    await env.OPERATOR_SETTINGS.revokePersonCredentials(row.email, false);
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
      personAuditStatement(env, request, caller, row.email, "PasswordReset", now),
    ]);
    const updated = await personRow(env.DB, row.id);
    if (updated === null) throw new Error(`user ${row.id} vanished after password reset`);
    return {
      ok: true,
      value: {
        person: person(updated, caller),
        resetUrl: `${configOf(env).loginOrigin}/reset/password#${token}`,
        expiresAt,
      },
    };
  },

  recordRefusal: (request) => {
    waitUntil(
      audit(env.DB, {
        actor: normalizeEmail(request.callerId),
        email: request.targetId,
        address: request.clientIp,
        event: "PeopleRequestRefused",
        outcome: "Refused",
        clientId: "api",
      }),
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
