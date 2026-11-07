import type { ApiError } from "@remit/api-openapi-types";
import { errorKindOfCode, quotaRefusal } from "./error-kind";
import { annotateLog } from "./log";

export const apiError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response => {
  annotateLog({ errorKind: errorKindOfCode(status, code) });
  const body: ApiError = { code, message };
  return Response.json(body, { status, headers });
};

export const quotaExceeded = (reason: string): Response =>
  apiError(429, "request_refused", quotaRefusal(reason));

export const notFound = (what: string): Response => apiError(404, "NotFound", `${what} not found`);

export const unauthorized = (reason: string): Response =>
  apiError(401, "Unauthorized", `Sign in again: ${reason}`);

export const rateLimited = (what: string, periodSeconds: number): Response =>
  apiError(
    429,
    "request_refused",
    `Too many requests for this ${what}; try again in ${periodSeconds} seconds`,
    { "retry-after": String(periodSeconds) },
  );

export const lengthRequired = (what: string): Response =>
  apiError(411, "LengthRequired", `Send ${what} with a content-length header`);

export const payloadTooLarge = (what: string, maxBytes: number): Response =>
  apiError(413, "PayloadTooLarge", `${what} is larger than the ${maxBytes} byte limit`);

export const contentLengthOf = (request: Request): number | undefined => {
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header)) return undefined;
  return Number(header);
};
