import type { ApiError } from "@remit/api-openapi-types";
import { errorKindOfCode, quotaRefusal } from "./error-kind";
import { annotateLog } from "./log";

export const apiError = (status: number, code: string, message: string): Response => {
  annotateLog({ errorKind: errorKindOfCode(status, code) });
  const body: ApiError = { code, message };
  return Response.json(body, { status });
};

export const quotaExceeded = (reason: string): Response =>
  apiError(429, "request_refused", quotaRefusal(reason));

export const notFound = (what: string): Response => apiError(404, "NotFound", `${what} not found`);

export const unauthorized = (reason: string): Response =>
  apiError(401, "Unauthorized", `Sign in again: ${reason}`);
