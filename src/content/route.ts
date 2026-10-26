import { buildBodyPartKey } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { notFound } from "../http";

const PREFIX = "/content/";
const CONTENT_PATH =
  /^\/content\/accounts\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/messages\/([A-Za-z0-9]+)\/parts\/([A-Za-z0-9.-]+)$/;
const SANDBOX = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";
const UNTYPED = "application/octet-stream";

export const isContentPath = (path: string): boolean => path.startsWith(PREFIX);

const notReady = (): Response =>
  new Response("body not yet synced", { status: 202, headers: { "retry-after": "5" } });

export const serveContent = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const match = CONTENT_PATH.exec(new URL(request.url).pathname);
  const [, accountConfigId, accountId, messageId, partPath] = match ?? [];
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
  return new Response(part.body, {
    headers: {
      "content-type": part.httpMetadata?.contentType ?? UNTYPED,
      "cache-control": "private, max-age=3600",
      "content-security-policy": SANDBOX,
      "x-content-type-options": "nosniff",
    },
  });
};
