import type { Tenant } from "../access";
import { apiError, notFound } from "../api/respond";
import type { Env } from "../env";
import { log } from "../log";
import { parseEmail } from "../mail/parse";
import { tenantMail } from "../stubs";
import { messageParts } from "./parts";
import { verifyContentSignature } from "./signature";

const PREFIX = "/content/";
const CONTENT_PATH =
  /^\/content\/accounts\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/messages\/([A-Za-z0-9]+)\/parts\/([A-Za-z0-9-]+)$/;
const SANDBOX = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";

export const contentPath = (
  accountConfigId: string,
  accountId: string,
  messageId: string,
  partPath: string,
): string => `accounts/${accountConfigId}/${accountId}/messages/${messageId}/parts/${partPath}`;

export const isContentPath = (path: string): boolean => path.startsWith(PREFIX);

const notReady = (): Response =>
  new Response("body not yet synced", { status: 202, headers: { "retry-after": "5" } });

export const serveContent = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const url = new URL(request.url);
  const match = CONTENT_PATH.exec(url.pathname);
  const [, , accountId, messageId, partPath] = match ?? [];
  if (accountId === undefined || messageId === undefined || partPath === undefined) {
    return notFound("Content");
  }
  const check = await verifyContentSignature(
    env,
    url.pathname.slice(PREFIX.length),
    url.searchParams.get("exp"),
    url.searchParams.get("sig"),
  );
  if (!check.valid) {
    log.warn("content signature rejected", { tenantId: tenant.tenantId, reason: check.reason });
    return apiError(403, "ContentSignature", `Content URL signature is ${check.reason}`);
  }
  const record = await tenantMail(env, tenant.tenantId).describeMessage(messageId);
  if (record === null || record.accountId !== accountId) return notFound("Message");
  if (record.bodyStorageKey === null) return notReady();
  const object = await env.MAIL.get(record.bodyStorageKey);
  if (object === null) throw new Error(`body object ${record.bodyStorageKey} is missing`);
  const part = messageParts(await parseEmail(object.body)).find(
    (candidate) => candidate.partPath === partPath,
  );
  if (part === undefined) return notFound("Body part");
  const headers = new Headers({
    "content-type": part.contentType,
    "cache-control": "private, max-age=3600",
    "content-security-policy": SANDBOX,
    "x-content-type-options": "nosniff",
  });
  if (part.disposition === "attachment") {
    headers.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(part.filename ?? "attachment")}`,
    );
  }
  return new Response(part.content, { headers });
};
