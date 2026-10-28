import type { RemitClient } from "@remit/backend/client";
import { handlers, publicHandlers } from "@remit/backend/handlers";
import { type ApiRegistry, type HandlerIdentity, serveApi } from "@remit/backend/serve";
import { refuseQuota } from "../error-kind";
import type { QueueName } from "../queue/routing";
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

const served = serveApi<QueueName>({
  handlers: quotaRefusing(handlers),
  publicHandlers,
});

export const ANONYMOUS: HandlerIdentity = { kind: "anonymous" };

export const serveRequest = (
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
