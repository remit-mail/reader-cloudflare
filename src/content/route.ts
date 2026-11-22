import { UnrecoverableBodyError } from "@remit/data-ports/errors";
import { buildExportArchiveKey, parseOutboxAttachmentKey } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { apiError, notFound } from "../http";
import { tenantMail } from "../stubs";

export const CONTENT_PREFIX = "/content/";
const EXPORT_PREFIX = "/exports/";
const BODY_PART_KEY =
  /^accounts\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/messages\/([A-Za-z0-9]+)\/parts\/([A-Za-z0-9.-]+)$/;
const SANDBOX = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";
const UNTYPED = "application/octet-stream";

export const isContentPath = (path: string): boolean => path.startsWith(CONTENT_PREFIX);
export const isExportPath = (path: string): boolean => path.startsWith(EXPORT_PREFIX);

const served = (object: R2ObjectBody, headers: Record<string, string> = {}): Response =>
  new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? UNTYPED,
      "cache-control": "private, max-age=3600",
      "content-security-policy": SANDBOX,
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

const notReady = (): Response =>
  new Response("body not yet synced", { status: 202, headers: { "retry-after": "5" } });

const unrecoverable = (): Response => {
  const error = new UnrecoverableBodyError(
    "This message's content could not be retrieved. Please report this issue.",
  );
  return apiError(error.statusCode, "unprocessable_entity", error.message);
};

const missed = async (
  env: Env,
  tenant: Tenant,
  [, accountConfigId = "", accountId = "", messageId = "", partPath = ""]: RegExpExecArray,
): Promise<Response> => {
  const miss = await tenantMail(env, tenant.tenantId).bodyReadMiss(tenant.tenantId, {
    accountConfigId,
    accountId,
    messageId,
    partPath,
  });
  switch (miss) {
    case "Pending":
      return notReady();
    case "Broken":
      return unrecoverable();
    case "NotFound":
      return notFound("Content");
  }
};

export const serveContent = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const { pathname } = new URL(request.url);
  const exporting = isExportPath(pathname);
  const key = pathname.slice(exporting ? 1 : CONTENT_PREFIX.length);
  if (exporting) {
    const [, , exportRequestId = ""] = key.split("/");
    const archive =
      key === buildExportArchiveKey(tenant.accountConfigId, exportRequestId)
        ? await env.MAIL.get(key)
        : null;
    const response =
      archive === null
        ? notFound("Export")
        : served(archive, {
            "content-disposition": `attachment; filename="remit-export-${exportRequestId}.zip"`,
          });
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  const outboxAttachment = parseOutboxAttachmentKey(key);
  if (outboxAttachment !== null) {
    if (outboxAttachment.accountConfigId !== tenant.accountConfigId) return notFound("Content");
    const attachment = await env.MAIL.get(key);
    if (attachment === null) return notFound("Attachment");
    return served(attachment);
  }
  const bodyPart = BODY_PART_KEY.exec(key);
  if (bodyPart === null || bodyPart[1] !== tenant.accountConfigId) return notFound("Content");
  const part = await env.MAIL.get(key);
  if (part === null) return missed(env, tenant, bodyPart);
  return served(part);
};
