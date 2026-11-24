import type { Person, PersonStatus } from "@remit/api-openapi-types";
import type {
  PeopleDirectory,
  PeopleOutcome,
  PeopleRequest,
  PersonRequest,
} from "@remit/auth-service/people";
import { PeopleErrorCode } from "@remit/domain-enums";
import type { PersonEmail } from "../../../src/operator-audit-contract";
import { audit, auditStatement } from "./audit";
import { mailerOf } from "./capture";
import { configOf, isOperator, normalizeEmail } from "./config";
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
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = user.email AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user WHERE user.id = ?1`,
    )
    .bind(userId, Date.now())
    .first<PersonRow>();

// callerId carries the caller's email, the one identity the app Worker and the
// login Worker share.
const activeCaller = (
  db: D1Database,
  request: Pick<PeopleRequest, "callerId">,
): Promise<Caller | null> =>
  db
    .prepare("SELECT id, email FROM user WHERE email = ? AND COALESCE(banned, 0) = 0")
    .bind(normalizeEmail(request.callerId))
    .first<Caller>();

interface Target {
  readonly caller: Caller;
  readonly row: PersonRow;
}

const target = async (
  env: Env,
  request: Pick<PersonRequest, "callerId" | "targetId">,
): Promise<PeopleOutcome<Target>> => {
  const caller = await activeCaller(env.DB, request);
  if (caller === null) return refused(PeopleErrorCode.CallerDisabled);
  const row = await personRow(env.DB, request.targetId);
  if (row === null || (row.id !== caller.id && isOperator(configOf(env), row.email))) {
    return refused("not_found");
  }
  return { ok: true, value: { caller, row } };
};

export const personEmail = async (
  env: Env,
  callerEmail: string,
  userId: string,
): Promise<PersonEmail> => {
  const found = await target(env, { callerId: callerEmail, targetId: userId });
  if (!found.ok) return { ok: false, refusal: "not_found" };
  return { ok: true, email: found.value.row.email };
};

const personAuditStatement = (
  env: Env,
  request: PeopleRequest,
  caller: Caller,
  email: string,
  event: "Disabled" | "Enabled" | "FactorReset" | "SignOutEverywhere",
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
  request: PersonRequest,
  status?: PersonStatus,
): Promise<PeopleOutcome<Target>> => {
  const found = await target(env, request);
  if (found.ok && status === "Disabled" && found.value.row.id === found.value.caller.id) {
    return refused(PeopleErrorCode.CannotDisableSelf);
  }
  return found;
};

export type LoginPeople = Pick<
  PeopleDirectory,
  "invitePerson" | "revokeInvite" | "resetPersonFactors" | "signOutPerson" | "updatePerson"
>;

export const peopleAdmin = (env: Env): LoginPeople => ({
  invitePerson: async (request) => {
    const caller = await activeCaller(env.DB, request);
    if (caller === null) return refused(PeopleErrorCode.CallerDisabled);
    const email = normalizeEmail(request.email);
    const existing = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
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
});
