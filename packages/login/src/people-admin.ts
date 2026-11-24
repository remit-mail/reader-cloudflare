import type { PersonEmail } from "../../../src/operator-audit-contract";
import { audit, auditStatement } from "./audit";
import { mailerOf } from "./capture";
import { configOf, isOperator, normalizeEmail } from "./config";
import type { Env } from "./env";
import { sendInvite } from "./mail";
import { issueInvite } from "./routes/app";

interface Identity {
  readonly id: string;
  readonly email: string;
}

interface AdminRequest {
  readonly callerId: string;
  readonly clientIp: string;
}

interface TargetRequest extends AdminRequest {
  readonly targetId: string;
}

type PersonStatus = "Active" | "Disabled";
export type LoginPeopleRefusal = "not_found" | "caller_disabled" | "cannot_disable_self";
type Refused = { readonly ok: false; readonly refusal: LoginPeopleRefusal };
type MutationOutcome = { readonly ok: true } | Refused;

const refused = (refusal: LoginPeopleRefusal): Refused => ({ ok: false, refusal });

export const activeCaller = (db: D1Database, email: string): Promise<Identity | null> =>
  db
    .prepare("SELECT id, email FROM user WHERE email = ? AND COALESCE(banned, 0) = 0")
    .bind(normalizeEmail(email))
    .first<Identity>();

const target = async (
  env: Env,
  callerEmail: string,
  targetId: string,
): Promise<{ ok: true; caller: Identity; row: Identity } | Refused> => {
  const caller = await activeCaller(env.DB, callerEmail);
  if (caller === null) return refused("caller_disabled");
  const row = await env.DB.prepare("SELECT id, email FROM user WHERE id = ?")
    .bind(targetId)
    .first<Identity>();
  if (row === null || (row.id !== caller.id && isOperator(configOf(env), row.email))) {
    return refused("not_found");
  }
  return { ok: true, caller, row };
};

export const personEmail = async (
  env: Env,
  callerEmail: string,
  userId: string,
): Promise<PersonEmail> => {
  const found = await target(env, callerEmail, userId);
  if (!found.ok) return { ok: false, refusal: "not_found" };
  return { ok: true, email: found.row.email };
};

const personAuditStatement = (
  env: Env,
  request: AdminRequest,
  caller: Identity,
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

export interface LoginPeople {
  invitePerson(request: AdminRequest & { email: string }): Promise<MutationOutcome>;
  revokeInvite(request: AdminRequest & { email: string }): Promise<MutationOutcome>;
  resetPersonFactors(request: TargetRequest): Promise<MutationOutcome>;
  signOutPerson(request: TargetRequest): Promise<MutationOutcome>;
  updatePerson(request: TargetRequest & { status: PersonStatus }): Promise<MutationOutcome>;
}

export const peopleAdmin = (env: Env): LoginPeople => ({
  invitePerson: async (request) => {
    const caller = await activeCaller(env.DB, request.callerId);
    if (caller === null) return refused("caller_disabled");
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
    return { ok: true };
  },

  revokeInvite: async (request) => {
    const caller = await activeCaller(env.DB, request.callerId);
    if (caller === null) return refused("caller_disabled");
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
    return { ok: true };
  },

  resetPersonFactors: async (request) => {
    const found = await target(env, request.callerId, request.targetId);
    if (!found.ok) return found;
    const { caller, row } = found;
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
    return { ok: true };
  },

  signOutPerson: async (request) => {
    const found = await target(env, request.callerId, request.targetId);
    if (!found.ok) return found;
    const { caller, row } = found;
    const now = Date.now();
    await env.OPERATOR_SETTINGS.revokePersonCredentials(row.email, false);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session WHERE user_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(row.id),
      personAuditStatement(env, request, caller, row.email, "SignOutEverywhere", now),
    ]);
    return { ok: true };
  },

  updatePerson: async (request) => {
    const found = await target(env, request.callerId, request.targetId);
    if (!found.ok) return found;
    const { caller, row } = found;
    const disabled = request.status === "Disabled";
    if (disabled && row.id === caller.id) return refused("cannot_disable_self");
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
    return { ok: true };
  },
});
