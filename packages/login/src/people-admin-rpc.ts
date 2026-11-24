import { WorkerEntrypoint } from "cloudflare:workers";
import type { Person } from "@remit/api-openapi-types";
import type { PeopleDirectory, PeopleRequest } from "@remit/auth-service/people";
import { PeopleErrorCode } from "@remit/domain-enums";
import { auditRows } from "./audit";
import type { Env } from "./env";
import { activeCaller } from "./people-admin";

interface PersonRow {
  readonly id: string;
  readonly email: string;
  readonly created_at: number;
  readonly banned: number | null;
  readonly sessions: number;
  readonly last_sign_in: number | null;
}

const adminRequired = () => ({
  ok: false as const,
  // The deployed app maps StepUpRequired to 403 through its existing refusal table.
  refusal: PeopleErrorCode.StepUpRequired,
  code: "forbidden",
  message: "Manage people from /admin on the login server.",
});

const callerDisabled = () => ({ ok: false as const, refusal: PeopleErrorCode.CallerDisabled });

export class PeopleAdmin extends WorkerEntrypoint<Env> implements PeopleDirectory {
  async listPeople(request: PeopleRequest): ReturnType<PeopleDirectory["listPeople"]> {
    const caller = await activeCaller(this.env.DB, request.callerId);
    if (caller === null) return callerDisabled();
    const rows = await this.env.DB.prepare(
      `SELECT user.id, user.email, user.created_at, user.banned,
        (SELECT COUNT(*) FROM session WHERE session.user_id = user.id AND session.expires_at > ?1) AS sessions,
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = user.email AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user ORDER BY user.email`,
    )
      .bind(Date.now())
      .all<PersonRow>();
    return {
      ok: true,
      value: rows.results.map(
        (row): Person => ({
          userId: row.id,
          email: row.email,
          createdAt: row.created_at,
          lastSignInAt: row.last_sign_in ?? row.created_at,
          sessionCount: row.sessions,
          status: row.banned ? "Disabled" : "Active",
          isCaller: row.id === caller.id,
        }),
      ),
    };
  }

  async listAudit(request: PeopleRequest): ReturnType<PeopleDirectory["listAudit"]> {
    if ((await activeCaller(this.env.DB, request.callerId)) === null) return callerDisabled();
    const rows = await auditRows(this.env.DB, 90);
    return {
      ok: true,
      value: rows.map((row) => ({
        auditEventId: row.auditEventId,
        occurredAt: row.at,
        actor: row.actor,
        target: row.email,
        action: row.event,
        outcome: row.outcome,
        clientIp: row.address,
      })),
    };
  }

  async invitePerson(..._args: Parameters<PeopleDirectory["invitePerson"]>) {
    return adminRequired();
  }

  async revokeInvite(..._args: Parameters<PeopleDirectory["revokeInvite"]>) {
    return adminRequired();
  }

  async resetPersonFactors(..._args: Parameters<PeopleDirectory["resetPersonFactors"]>) {
    return adminRequired();
  }

  async createStepUp(..._args: Parameters<PeopleDirectory["createStepUp"]>) {
    return adminRequired();
  }

  async signOutPerson(..._args: Parameters<PeopleDirectory["signOutPerson"]>) {
    return adminRequired();
  }

  async updatePerson(..._args: Parameters<PeopleDirectory["updatePerson"]>) {
    return adminRequired();
  }

  async createPasswordReset(..._args: Parameters<PeopleDirectory["createPasswordReset"]>) {
    return adminRequired();
  }

  recordRefusal(..._args: Parameters<PeopleDirectory["recordRefusal"]>) {
    return adminRequired();
  }
}
