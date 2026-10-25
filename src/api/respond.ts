import type { ApiError, ValidationError } from "@remit/api-openapi-types";
import type { ZodIssue } from "zod";
import { errorKindOfCode } from "../error-kind";
import { annotateLog } from "../log";

export const ok = <T>(body: T): Response => Response.json(body);

export const apiError = (status: number, code: string, message: string): Response => {
  annotateLog({ errorKind: errorKindOfCode(status, code) });
  const body: ApiError = { code, message };
  return Response.json(body, { status });
};

export const quotaExceeded = (reason: string): Response => {
  const response = apiError(
    429,
    "request_refused",
    `This account hit a Cloudflare storage or request limit; try again later. ${reason}`,
  );
  annotateLog({ errorKind: "quota" });
  return response;
};

export const notFound = (what: string): Response => apiError(404, "NotFound", `${what} not found`);

export const unauthorized = (reason: string): Response =>
  apiError(401, "Unauthorized", `Sign in again: ${reason}`);

export const invalid = (message: string, issues: readonly ZodIssue[] = []): Response => {
  annotateLog({ errorKind: "validation" });
  const body: ValidationError = {
    statusCode: 400,
    code: "ValidationError",
    message,
    errors: issues.map((issue) => ({
      path: issue.path.join("."),
      rule: issue.code,
      message: issue.message,
    })),
  };
  return Response.json(body, { status: 400 });
};

export const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> => {
  const entry: Partial<Record<K, V>> = {};
  if (value === null || value === undefined) return entry;
  entry[key] = value;
  return entry;
};

export const conflict = (
  code: string,
  message: string,
  details: Readonly<Record<string, string>>,
): Response => {
  annotateLog({ errorKind: errorKindOfCode(409, code) });
  const body: ApiError = { code, message, details: { ...details } };
  return Response.json(body, { status: 409 });
};
