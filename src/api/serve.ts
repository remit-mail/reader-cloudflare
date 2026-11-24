import type { PeopleDirectory } from "@remit/auth-service/people";
import type { RemitClient } from "@remit/backend/client";
import { handlers, publicHandlers } from "@remit/backend/handlers";
import {
  type ApiRegistry,
  type HandlerIdentity,
  serveApi,
  type UserIdentity,
} from "@remit/backend/serve";
import { refuseQuota } from "../error-kind";
import { withPartition } from "../http";
import type {
  LoginOperatorService,
  OperatorAuditEvent,
  OperatorAuditRecord,
} from "../operator-audit-contract";
import type { QueueName } from "../queue/routing";
import { mailTenantOfEmail } from "../tenant-email";
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

const clientIpOf = (request: Request): string =>
  request.headers.get("x-remit-client-ip") ?? request.headers.get("cf-connecting-ip") ?? "unknown";

const PERSON_SETTINGS = /^\/people\/([^/]+)\/settings(?:\/(classification-provider))?$/;

const operatorAudit = (
  request: Request,
  identity: UserIdentity,
  targetEmail: string,
  outcome: OperatorAuditRecord["outcome"],
): OperatorAuditRecord | undefined => {
  const path = new URL(request.url).pathname.slice(API_ROOT.length);
  let event: OperatorAuditEvent | undefined;
  if (path === "/system/classification-default") {
    if (request.method === "PUT") event = "ClassificationSet";
    if (request.method === "DELETE") event = "ClassificationCleared";
  } else {
    const match = PERSON_SETTINGS.exec(path);
    if (match !== null) {
      if (request.method === "PATCH" && match[2] === undefined) event = "SettingsUpdated";
      if (request.method === "DELETE" && match[2] !== undefined) event = "ClassificationCleared";
    }
  }
  if (event === undefined) return undefined;
  return {
    actorEmail: identity.email,
    targetEmail,
    address: clientIpOf(request),
    event,
    outcome,
    clientId: "api",
  };
};

export const serveRequest = (
  request: Request,
  identity: HandlerIdentity,
  operator: boolean,
  client: RemitClient,
  correlationId: string,
  people: PeopleDirectory | null,
): Promise<Response> => {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(API_ROOT.length);
  return servedApi().handleFetch(
    new Request(url, request),
    {
      config: apiConfig,
      client: async () => client,
      identity: async () => identity,
      operator: async () => operator,
      peopleDirectory: async () => people,
    },
    correlationId,
  );
};

const callingAs = (people: PeopleDirectory, callerEmail: string): PeopleDirectory => ({
  listPeople: (request) => people.listPeople({ ...request, callerId: callerEmail }),
  listAudit: (request) => people.listAudit({ ...request, callerId: callerEmail }),
  invitePerson: (request) => people.invitePerson({ ...request, callerId: callerEmail }),
  revokeInvite: (request) => people.revokeInvite({ ...request, callerId: callerEmail }),
  resetPersonFactors: (request) => people.resetPersonFactors({ ...request, callerId: callerEmail }),
  createStepUp: (request) => people.createStepUp({ ...request, callerId: callerEmail }),
  signOutPerson: (request) => people.signOutPerson({ ...request, callerId: callerEmail }),
  updatePerson: (request) => people.updatePerson({ ...request, callerId: callerEmail }),
  createPasswordReset: (request) =>
    people.createPasswordReset({ ...request, callerId: callerEmail }),
  recordRefusal: (request) => people.recordRefusal({ ...request, callerId: callerEmail }),
});

export interface OperatorCall {
  readonly login: Pick<LoginOperatorService, "writeAudit">;
  readonly targetEmail: string;
}

export const serveUserRequest = async (
  request: Request,
  identity: UserIdentity,
  operator: boolean,
  client: RemitClient,
  correlationId: string,
  people: PeopleDirectory,
  call: OperatorCall,
  partitionKey: string,
): Promise<Response> => {
  const response = withPartition(
    await serveRequest(
      request,
      identity,
      operator,
      client,
      correlationId,
      callingAs(people, identity.email),
    ),
    partitionKey,
  );
  if (!operator) return response;
  const record = operatorAudit(
    request,
    identity,
    call.targetEmail,
    response.ok ? "Succeeded" : "Refused",
  );
  if (record !== undefined) await call.login.writeAudit(record);
  return response;
};

export type PersonSettingsRoute =
  | { readonly kind: "Own" }
  | { readonly kind: "NotFound" }
  | {
      readonly kind: "Person";
      readonly tenantId: string;
      readonly email: string;
      readonly request: Request;
    };

export const personSettingsRoute = async (
  request: Request,
  identity: UserIdentity,
  operator: boolean,
  db: D1Database,
  login: Pick<LoginOperatorService, "personEmail">,
): Promise<PersonSettingsRoute> => {
  const url = new URL(request.url);
  const match = PERSON_SETTINGS.exec(url.pathname.slice(API_ROOT.length));
  if (match === null || !operator) return { kind: "Own" };
  const userId = decodeURIComponent(match[1] ?? "");
  const person = await login.personEmail(identity.email, userId);
  if (!person.ok) return { kind: "NotFound" };
  const { email } = person;
  const tenantId = await mailTenantOfEmail(db, email);
  if (tenantId === undefined) return { kind: "NotFound" };
  const rest = match[2] === undefined ? "" : `/${match[2]}`;
  url.pathname = `${API_ROOT}/people/${encodeURIComponent(tenantId)}/settings${rest}`;
  return { kind: "Person", tenantId, email, request: new Request(url, request) };
};
