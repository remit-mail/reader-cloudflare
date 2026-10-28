import { buildBodyPartKey, parseOutboxAttachmentKey } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { notFound } from "../http";

const PREFIX = "/content/";
const CONTENT_PATH =
  /^\/content\/accounts\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/messages\/([A-Za-z0-9]+)\/parts\/([A-Za-z0-9.-]+)$/;
const SANDBOX = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";
const UNTYPED = "application/octet-stream";

export const isContentPath = (path: string): boolean => path.startsWith(PREFIX);

const served = (object: R2ObjectBody): Response =>
  new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? UNTYPED,
      "cache-control": "private, max-age=3600",
      "content-security-policy": SANDBOX,
      "x-content-type-options": "nosniff",
    },
  });

const serveOutboxAttachment = async (
  path: string,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const key = path.slice(PREFIX.length);
  const target = parseOutboxAttachmentKey(key);
  if (target === null || target.accountConfigId !== tenant.accountConfigId) {
    return notFound("Content");
  }
  const attachment = await env.MAIL.get(key);
  if (attachment === null) return notFound("Attachment");
  return served(attachment);
};

const notReady = (): Response =>
  new Response("body not yet synced", { status: 202, headers: { "retry-after": "5" } });

export const serveContent = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const path = new URL(request.url).pathname;
  const match = CONTENT_PATH.exec(path);
  if (match === null) return serveOutboxAttachment(path, env, tenant);
  const [, accountConfigId, accountId, messageId, partPath] = match;
  if (
    accountConfigId === undefined ||
    accountId === undefined ||
    messageId === undefined ||
    partPath === undefined ||
    accountConfigId !== tenant.accountConfigId
  ) {
    return notFound("Content");
  }
  const part = await env.MAIL.get(
    buildBodyPartKey(accountConfigId, accountId, messageId, partPath),
  );
  if (part === null) return notReady();
  return served(part);
};
