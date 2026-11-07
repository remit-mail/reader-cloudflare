import { requireTenant } from "./access";
import { LOGIN_MAIL_PATH } from "./api/paths";
import type { Env } from "./env";
import { apiError, notFound, unauthorized } from "./http";
import { log } from "./log";

export interface CapturedLoginMail {
  readonly capturedMailId: string;
  readonly capturedAt: number;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

export interface LoginMailReader {
  latest(): Promise<CapturedLoginMail[]>;
}

export const serveLoginMail = async (request: Request, env: Env): Promise<Response> => {
  const reader = env.LOGIN_MAIL;
  const agent = env.LOGIN_MAIL_READER;
  if (reader === undefined || agent === undefined || request.method !== "GET") {
    return notFound("Captured login mail");
  }
  const result = await requireTenant(request, env);
  if (!result.ok) {
    log.warn("access denied", { path: LOGIN_MAIL_PATH, reason: result.reason });
    return unauthorized(result.reason);
  }
  if (result.tenant.tenantId !== agent) {
    return apiError(403, "Forbidden", "Only the agent service token reads captured login mail");
  }
  const messages = await reader.latest();
  return Response.json({ messages }, { headers: { "cache-control": "no-store" } });
};
