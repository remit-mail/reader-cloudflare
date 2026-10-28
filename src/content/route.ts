import { parseOutboxAttachmentKey } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { notFound } from "../http";

const PREFIX = "/content/";
const BODY_PART_KEY =
  /^accounts\/([A-Za-z0-9]+)\/[A-Za-z0-9]+\/messages\/[A-Za-z0-9]+\/parts\/[A-Za-z0-9.-]+$/;
const SANDBOX = "sandbox; default-src none; img-src * data:; style-src unsafe-inline";
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

const notReady = (): Response =>
  new Response("body not yet synced", { status: 202, headers: { "retry-after": "5" } });

export const serveContent = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const key = new URL(request.url).pathname.slice(PREFIX.length);
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
