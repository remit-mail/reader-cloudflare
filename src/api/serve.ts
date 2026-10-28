import type { RemitClient } from "@remit/backend/client";
import { handlers, publicHandlers } from "@remit/backend/handlers";
import {
  type ApiRegistry,
  type HandlerIdentity,
  serveApi,
  type UserIdentity,
} from "@remit/backend/serve";
import { refuseQuota } from "../error-kind";
import type { QueueName } from "../queue/routing";
import { apiConfig } from "./config";
import { API_ROOT } from "./paths";

type Handlers = ApiRegistry<QueueName>["handlers"];

type Handler = NonNullable<Handlers[keyof Handlers]>;

const unservedOperations = [
  "FilterOperations_createFilter",
  "MeOperations_createExport",
  "MeOperations_deleteMe",
  "MessageOperations_getRawMessage",
  "OrganizeOperations_createOrganizeJob",
  "OutboxDetailOperations_deleteOutboxMessage",
] as const satisfies readonly (keyof typeof handlers)[];

const without = <T extends object, K extends keyof T>(
  registry: T,
  keys: readonly K[],
): Partial<T> => {
  const kept: Partial<T> = { ...registry };
  for (const key of keys) delete kept[key];
  return kept;
};

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

const microsoftSignInUnconfigured: Handler = async () => ({
  statusCode: 501,
  body: {
    code: "not_configured",
    message:
      "Microsoft sign-in is not configured on this deployment: its deploy config sets no msoauth_client_id and msoauth_client_secret.",
  },
});

const hostHandlers = (): Handlers => {
  const served = without(handlers, unservedOperations);
  if (apiConfig.msOAuth.mode === "Enabled") return served;
  return { ...served, MicrosoftOAuthOperations_microsoftOAuthStart: microsoftSignInUnconfigured };
};

const served = serveApi<QueueName>({
  handlers: quotaRefusing(hostHandlers()),
  publicHandlers,
});

const anonymous: HandlerIdentity = { kind: "anonymous" };

const serve = (
  request: Request,
  identity: HandlerIdentity,
  client: RemitClient,
  correlationId: string,
): Promise<Response> => {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(API_ROOT.length);
  return served.handleFetch(
    new Request(url, request),
    { config: apiConfig, client: async () => client, identity: async () => identity },
    correlationId,
  );
};

export const serveTenantApi = (
  request: Request,
  identity: UserIdentity,
  client: RemitClient,
  correlationId: string,
): Promise<Response> => serve(request, identity, client, correlationId);

export const servePublicApi = (
  request: Request,
  client: RemitClient,
  correlationId: string,
): Promise<Response> => serve(request, anonymous, client, correlationId);
