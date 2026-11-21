import type { PeopleDirectory, PeopleRefusal } from "@remit/auth-service/people";
import { PeopleErrorCode } from "@remit/domain-enums";
import { z } from "zod";
import type {
  ClassificationInput,
  OperatorSettingsService,
} from "../../../../src/operator-settings-contract";
import {
  type AdminUser,
  adminPage,
  auditPage,
  type ClassificationRead,
  enrollPage,
  type TenantClassificationRead,
  toResponse,
  type UserState,
} from "../admin-page";
import { type AuditEntry, auditRows, auditStatement } from "../audit";
import type { Auth } from "../auth";
import { addressOf, clearKey, userKey } from "../backoff";
import { isOperator, type LoginConfig, normalizeEmail } from "../config";
import { json, notFound } from "../http";
import { reserveOrAudit } from "../second-factor";
import {
  type AdminAction,
  type Binding,
  consumeChallenge,
  isAdminAction,
  loadOperatorFactors,
  type Operator,
  openChallenge,
  type Proof,
  SELF_ACTIONS,
  stepUpMethodOf,
  verifyProof,
} from "../step-up";

export interface AdminContext {
  readonly auth: Auth;
  readonly config: LoginConfig;
  readonly db: D1Database;
  readonly people: PeopleDirectory;
  readonly settings: OperatorSettingsService;
}

interface OperatorSession {
  readonly operator: Operator;
  readonly sessionId: string;
}

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
  id: string;
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
      `SELECT user.id AS id, user.email AS email, user.banned AS banned, user.two_factor_enabled AS two_factor_enabled,
        (SELECT COUNT(*) FROM passkey WHERE passkey.user_id = user.id) AS passkeys,
        (SELECT COUNT(*) FROM session WHERE session.user_id = user.id AND session.expires_at > ?1) AS sessions,
        (SELECT MAX(at) FROM audit_event WHERE audit_event.email = lower(user.email) AND event = 'SignIn' AND outcome = 'Succeeded') AS last_sign_in
      FROM user ORDER BY user.email`,
    )
    .bind(now)
    .all<UserListRow>();
  const invited = await db
    .prepare(
      "SELECT email, MAX(expires_at) AS expires_at FROM invite WHERE state = 'Open' AND email NOT IN (SELECT lower(email) FROM user) GROUP BY email ORDER BY email",
    )
    .all<{ email: string; expires_at: number }>();
  const stateOf = (row: UserListRow): UserState => (row.banned ? "disabled" : "active");
  return [
    ...users.results.map((row) => ({
      userId: row.id,
      email: row.email,
      state: stateOf(row),
      passkeys: row.passkeys,
      app: Boolean(row.two_factor_enabled),
      sessions: row.sessions,
      lastSignIn: row.last_sign_in,
    })),
    ...invited.results.map((row) => ({
      userId: null,
      email: row.email,
      state: row.expires_at > now ? ("invited" as const) : ("expired" as const),
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
  const [users, classification, tenantSettings] = await Promise.all([
    listUsers(context.db, Date.now()),
    context.settings.readClassification().then(
      (view): ClassificationRead => ({ ok: true, view }),
      (error: unknown): ClassificationRead => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    context.settings.readTenantClassifications(session.operator.userId, session.operator.email),
  ]);
  const emailById = new Map(
    users.flatMap((user) => (user.userId === null ? [] : [[user.userId, user.email] as const])),
  );
  const tenants: TenantClassificationRead[] = tenantSettings.flatMap((tenant) => {
    const email = emailById.get(tenant.userId);
    return email === undefined ? [] : [{ ok: true, email, ...tenant }];
  });
  return toResponse(
    adminPage(session.operator.email, users, classification, tenants, (email) =>
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
  classification: z
    .object({
      presetId: z.enum(["Jev", "Jina", "Mistral", "Gemini", "OpenAiCompatible", "Local"]),
      model: z.string().max(200),
      baseUrl: z.string().max(2048),
      apiKey: z.string().max(4096),
      dailyLimit: z.number(),
      enabled: z.boolean(),
    })
    .optional(),
});

type TargetCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const checkTarget = (
  config: LoginConfig,
  operator: Operator,
  action: AdminAction,
  targetEmail: string,
): TargetCheck => {
  if (SELF_ACTIONS.has(action)) {
    return targetEmail === operator.email
      ? { ok: true }
      : { ok: false, message: "This action names your own email as its target." };
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
  RevokeKeys: "KeysRevoked",
  RevokeInvite: "InviteRevoked",
  SetClassification: "ClassificationSet",
  ClearClassification: "ClassificationCleared",
  SetTenantClassification: "ClassificationSet",
  ClearTenantClassification: "ClassificationCleared",
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
  classification: ClassificationInput | undefined,
): Promise<Outcome> => {
  const { db } = context;
  const now = Date.now();
  const audited = auditStatement(db, entry, now);
  if (action === "ClearTenantClassification") {
    const target = await userIdOf(db, targetEmail);
    if (target === null)
      return { ok: false, status: 404, message: `${targetEmail} has no account.` };
    await context.settings.clearTenantClassification(target.id, operator.userId, operator.email);
    await audited.run();
    return { ok: true, message: `Cleared the classifier settings of ${targetEmail}.` };
  }
  if (action === "SetTenantClassification") {
    if (classification === undefined) {
      await auditStatement(db, { ...entry, outcome: "Refused" }, now).run();
      return { ok: false, status: 400, message: "Send the classifier settings to save." };
    }
    const target = await userIdOf(db, targetEmail);
    if (target === null)
      return { ok: false, status: 404, message: `${targetEmail} has no account.` };
    const written = await context.settings.writeTenantClassification(
      target.id,
      classification,
      operator.userId,
      operator.email,
    );
    if (!written.ok) {
      await auditStatement(db, { ...entry, outcome: "Refused" }, now).run();
      return { ok: false, status: 400, message: written.message };
    }
    await audited.run();
    return { ok: true, message: `Saved the classifier settings of ${targetEmail}.` };
  }
  if (action === "ClearClassification") {
    await context.settings.clearClassification();
    await audited.run();
    return { ok: true, message: "Cleared the classifier override." };
  }
  if (action === "SetClassification") {
    if (classification === undefined) {
      await auditStatement(db, { ...entry, outcome: "Refused" }, now).run();
      return { ok: false, status: 400, message: "Send the classifier settings to save." };
    }
    const written = await context.settings.writeClassification(classification, operator.email);
    if (!written.ok) {
      await auditStatement(db, { ...entry, outcome: "Refused" }, now).run();
      return { ok: false, status: 400, message: written.message };
    }
    await audited.run();
    return { ok: true, message: "Saved the classifier default." };
  }
  if (action === "Invite") {
    const invited = await context.people.invitePerson({
      callerId: operator.userId,
      clientIp: entry.address,
      email: targetEmail,
    });
    if (!invited.ok) return peopleFailure(invited.refusal, targetEmail);
    return { ok: true, message: `Invited ${targetEmail}.` };
  }
  if (action === "RevokeInvite") {
    const revoked = await context.people.revokeInvite({
      callerId: operator.userId,
      clientIp: entry.address,
      email: targetEmail,
    });
    if (!revoked.ok) return peopleFailure(revoked.refusal, targetEmail);
    return { ok: true, message: `Revoked the invite of ${targetEmail}.` };
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
  const request = { callerId: operator.userId, clientIp: entry.address, targetId: target.id };
  if (action === "Disable") {
    const changed = await context.people.updatePerson({
      ...request,
      operatorGrant: true,
      stepUpToken: null,
      status: "Disabled",
    });
    if (!changed.ok) return peopleFailure(changed.refusal, targetEmail);
    return { ok: true, message: `Disabled ${targetEmail}.` };
  }
  if (action === "Enable") {
    if (!target.banned)
      return { ok: false, status: 409, message: `${targetEmail} is not disabled.` };
    const changed = await context.people.updatePerson({
      ...request,
      operatorGrant: true,
      stepUpToken: null,
      status: "Active",
    });
    if (!changed.ok) return peopleFailure(changed.refusal, targetEmail);
    return { ok: true, message: `Enabled ${targetEmail}.` };
  }
  if (action === "ResetFactors") {
    const changed = await context.people.resetPersonFactors(request);
    if (!changed.ok) return peopleFailure(changed.refusal, targetEmail);
    return { ok: true, message: `Reset the factors of ${targetEmail}.` };
  }
  const changed = await context.people.signOutPerson({
    ...request,
    operatorGrant: true,
    stepUpToken: null,
  });
  if (!changed.ok) return peopleFailure(changed.refusal, targetEmail);
  return { ok: true, message: `Signed ${targetEmail} out everywhere.` };
};

const peopleFailure = (refusal: PeopleRefusal, email: string): Outcome => {
  if (refusal === "not_found") {
    return { ok: false, status: 404, message: `${email} was not found.` };
  }
  if (refusal === PeopleErrorCode.CannotDisableSelf) {
    return { ok: false, status: 409, message: "You cannot disable your own account." };
  }
  return { ok: false, status: 403, message: `The people directory refused ${refusal}.` };
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
  const { adminChallengeId, assertion, totpCode, classification } = parsed.data;
  const action = parsed.data.action;
  const targetEmail = normalizeEmail(parsed.data.targetEmail);
  const address = addressOf(request);
  const target = checkTarget(context.config, operator, action, targetEmail);
  if (!target.ok) return refuse(context, operator, action, targetEmail, address, target.message);
  const personal = userKey(operator.userId);
  const reservation = await reserveOrAudit(
    context.db,
    [personal],
    operator.email,
    operator.email,
    address,
  );
  if (!reservation.allowed) {
    return json(429, {
      message: "Too many failed confirmations. Try again later.",
      retryAt: new Date(reservation.retryAt).toISOString(),
    });
  }
  const now = Date.now();
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
    return json(403, { message: "The confirmation did not verify. Nothing was changed." });
  }
  await clearKey(context.db, personal);
  const outcome = await runAction(
    context,
    operator,
    action,
    targetEmail,
    {
      actor: operator.email,
      email: targetEmail,
      address,
      event: AUDIT_EVENT[action],
      outcome: "Succeeded",
    },
    classification,
  );
  if (!outcome.ok) return json(outcome.status, { message: outcome.message });
  return json(200, { message: outcome.message });
};
