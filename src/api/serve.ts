import type { PeopleDirectory } from "@remit/auth-service/people";
import type { RemitClient } from "@remit/backend/client";
import { handlers, publicHandlers } from "@remit/backend/handlers";
import { type ApiRegistry, type HandlerIdentity, serveApi } from "@remit/backend/serve";
import { refuseQuota } from "../error-kind";
import type {
  LoginOperatorService,
  OperatorAuditEvent,
  OperatorAuditRecord,
} from "../operator-audit-contract";
import type { QueueName } from "../queue/routing";
import { tenantOfUser } from "../tenant-directory";
import { emailOfTenant } from "../tenant-email";
import { apiConfig } from "./config";
import { API_ROOT } from "./paths";

type Handlers = ApiRegistry<QueueName>["handlers"];

type Handler = NonNullable<Handlers[keyof Handlers]>;

const refusingQuota =
  (handler: Handler): Handler =>
  (context, ctx) =>
    handler(context, ctx).catch(refuseQuota);

const quotaRefusing = (registry: Handlers): Handlers =>
  Object.fromEntries(
    Object.entries(registry).flatMap(([operationId, handler]) =>
      handler === undefined ? [] : [[operationId, refusingQuota(handler)]],
    ),
  );

let served: ReturnType<typeof serveApi<QueueName>> | undefined;

const servedApi = (): ReturnType<typeof serveApi<QueueName>> => {
  served ??= serveApi<QueueName>({ handlers: quotaRefusing(handlers), publicHandlers });
  return served;
};

export const ANONYMOUS: HandlerIdentity = { kind: "anonymous" };

export interface OperatorAuditEntry
  extends Omit<OperatorAuditRecord, "actorEmail" | "targetEmail"> {
  readonly actorId: string;
  readonly targetId: string;
}

export type OperatorAudit = (entry: OperatorAuditEntry) => Promise<void>;

const recordedEmailOf = async (db: D1Database, tenantId: string): Promise<string> => {
  const email = await emailOfTenant(db, tenantId);
  if (email === undefined) throw new Error(`tenant ${tenantId} has no recorded email`);
  return email;
};

export const operatorAuditVia =
  (db: D1Database, login: Pick<LoginOperatorService, "writeAudit">): OperatorAudit =>
  async ({ actorId, targetId, ...entry }) => {
    const [actorEmail, targetEmail] = await Promise.all([
      recordedEmailOf(db, actorId),
      recordedEmailOf(db, targetId),
    ]);
    await login.writeAudit({ ...entry, actorEmail, targetEmail });
  };

const operatorAudit = (
  request: Request,
  identity: HandlerIdentity,
  outcome: OperatorAuditRecord["outcome"],
): OperatorAuditEntry | undefined => {
  if (identity.kind !== "user") return undefined;
  const path = new URL(request.url).pathname.slice(API_ROOT.length);
  let event: OperatorAuditEvent | undefined;
  let targetId = identity.sub;
  if (path === "/system/classification-default") {
    if (request.method === "PUT") event = "ClassificationSet";
    if (request.method === "DELETE") event = "ClassificationCleared";
  } else {
    const match = /^\/people\/([^/]+)\/settings(?:\/(classification-provider))?$/.exec(path);
    if (match !== null) {
      targetId = decodeURIComponent(match[1] ?? "");
      if (request.method === "PATCH" && match[2] === undefined) event = "SettingsUpdated";
      if (request.method === "DELETE" && match[2] !== undefined) event = "ClassificationCleared";
    }
  }
  if (event === undefined) return undefined;
  return {
    actorId: identity.sub,
    targetId,
    address:
      request.headers.get("x-remit-client-ip") ??
      request.headers.get("cf-connecting-ip") ??
      "unknown",
    event,
    outcome,
    clientId: "api",
  };
};

export const serveRequest = async (
  request: Request,
  identity: HandlerIdentity,
  operator: boolean,
  client: RemitClient,
  correlationId: string,
  audit: OperatorAudit,
  people: PeopleDirectory | null,
): Promise<Response> => {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(API_ROOT.length);
  const response = await servedApi().handleFetch(
    new Request(url, request),
    {
      config: apiConfig,
      client: async () => client,
      identity: async () => identity,
      operator: async () => operator,
      operatorGrant: async () => operator,
      peopleDirectory: async () => people,
    },
    correlationId,
  );
  if (operator) {
    const record = operatorAudit(request, identity, response.ok ? "Succeeded" : "Refused");
    if (record !== undefined) await audit(record);
  }
  return response;
};

export type PersonSettingsTarget =
  | { readonly targeted: false }
  | { readonly targeted: true; readonly tenantId: string | undefined };

export const personSettingsTarget = async (
  request: Request,
  db: D1Database,
): Promise<PersonSettingsTarget> => {
  const path = new URL(request.url).pathname.slice(API_ROOT.length);
  const match = /^\/people\/([^/]+)\/settings(?:\/classification-provider)?$/.exec(path);
  if (match === null) return { targeted: false };
  return {
    targeted: true,
    tenantId: await tenantOfUser(db, decodeURIComponent(match[1] ?? "")),
  };
};
