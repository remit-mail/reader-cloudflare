import spec from "@remit/api-openapi-spec/openapi.json";
import { type Context, type Document, OpenAPIBackend } from "openapi-backend";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { log } from "../log";
import { configHandlers } from "./handlers/config";
import { messageHandlers } from "./handlers/messages";
import { outboxHandlers } from "./handlers/outbox";
import { syncHandlers } from "./handlers/sync";
import { threadHandlers } from "./handlers/threads";
import type { ApiRequest, Handler } from "./request";
import { apiError, invalid, notFound } from "./respond";

const API_ROOT = "/api";
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDocument = (value: unknown): value is Document =>
  isRecord(value) && typeof value.openapi === "string" && isRecord(value.paths);

const definition = (): Document => {
  if (!isDocument(spec)) throw new Error("@remit/api-openapi-spec is not an OpenAPI document");
  return spec;
};

const emptied = (mock: unknown): unknown => {
  if (Array.isArray(mock)) return [];
  if (!isRecord(mock)) return mock;
  return Object.fromEntries(
    Object.entries(mock)
      .filter(([key]) => key !== "continuationToken")
      .map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  );
};

const systemUpdate: Handler = async () => notFound("System update");

const handlers: Record<string, Handler> = {
  ...configHandlers,
  ...threadHandlers,
  ...messageHandlers,
  ...outboxHandlers,
  ...syncHandlers,
  SystemOperations_getSystemUpdate: systemUpdate,
};

const api = new OpenAPIBackend({
  definition: definition(),
  apiRoot: API_ROOT,
  quick: true,
  validate: false,
});

api.registerSecurityHandler("CognitoAuthorizer", () => true);

api.register({
  ...handlers,
  notFound: async () => notFound("Operation"),
  methodNotAllowed: async () => apiError(405, "MethodNotAllowed", "Method not allowed"),
  notImplemented: async (context: Context) => {
    const operationId = context.operation.operationId ?? "";
    const { status, mock } = api.mockResponseForOperation(operationId);
    log.info("operation not implemented", { operationId, status });
    return Response.json(emptied(mock), { status });
  },
});

const ready = api.init();

const queryOf = (url: URL): Record<string, string | string[]> => {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 && values[0] !== undefined ? values[0] : values;
  }
  return query;
};

type Body = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const readBody = async (request: Request): Promise<Body> => {
  if (!BODY_METHODS.has(request.method)) return { ok: true, value: undefined };
  const text = await request.text();
  if (text === "") return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
};

export const handleApi = async (request: Request, env: Env, tenant: Tenant): Promise<Response> => {
  await ready;
  const url = new URL(request.url);
  const body = await readBody(request);
  if (!body.ok) return invalid("Request body is not valid JSON");
  const apiRequest: ApiRequest = { env, tenant, origin: url.origin, body: body.value };
  const response: unknown = await api.handleRequest(
    {
      method: request.method,
      path: url.pathname,
      query: queryOf(url),
      headers: Object.fromEntries(request.headers),
      body: body.value,
    },
    apiRequest,
  );
  if (response instanceof Response) return response;
  throw new Error(`handler for ${request.method} ${url.pathname} returned no Response`);
};
