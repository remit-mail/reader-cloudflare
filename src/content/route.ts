import { buildExportArchiveKey, parseOutboxAttachmentKey } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { notFound } from "../http";

export const CONTENT_PREFIX = "/content/";
const BODY_PART_KEY =
  /^accounts\/([A-Za-z0-9]+)\/[A-Za-z0-9]+\/messages\/[A-Za-z0-9]+\/parts\/[A-Za-z0-9.-]+$/;
const SANDBOX = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";
const UNTYPED = "application/octet-stream";

export const isContentPath = (path: string): boolean => path.startsWith(CONTENT_PREFIX);

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

export const serveContent = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const key = new URL(request.url).pathname.slice(CONTENT_PREFIX.length);
  const [, , exportRequestId = ""] = key.split("/");
  if (key === buildExportArchiveKey(tenant.accountConfigId, exportRequestId)) {
    const archive = await env.MAIL.get(key);
    if (archive === null) return notFound("Export");
    return served(archive, {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="remit-export-${exportRequestId}.zip"`,
    });
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
  if (part === null) return notReady();
  return served(part);
};
