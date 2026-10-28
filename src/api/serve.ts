import type { RemitClient } from "@remit/backend/client";
import { handlers, publicHandlers } from "@remit/backend/handlers";
import { type ApiRegistry, serveApi, type UserIdentity } from "@remit/backend/serve";
import { refuseQuota } from "../error-kind";
import type { QueueName } from "../queue/routing";
import { apiConfig } from "./config";

export const API_ROOT = "/api";

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

const unservedPublicOperations = [
  "CalendarFeedOperations_getCalendarFeedIcal",
  "MicrosoftOAuthOperations_microsoftOAuthCallback",
] as const satisfies readonly (keyof typeof publicHandlers)[];

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

const served = serveApi<QueueName>({
  handlers: quotaRefusing(without(handlers, unservedOperations)),
  publicHandlers: without(publicHandlers, unservedPublicOperations),
});

export const serveTenantApi = (
  request: Request,
  identity: UserIdentity,
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
