import type { Tenant } from "../access";
import { r2Storage } from "../api/storage";
import type { Env } from "../env";
import { notFound } from "../http";
import { parseEmail } from "../mail/parse";
import { tenantMail } from "../stubs";
import { messageParts } from "./parts";

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
  const record = await tenantMail(env, tenant.tenantId).describeMessage(accountConfigId, messageId);
  if (record === null || record.accountId !== accountId) return notFound("Message");
  const key = record.message.bodyStorageKey;
  if (key === undefined) return notReady();
  const body = await r2Storage(env.MAIL).retrieve(key);
  const part = messageParts(await parseEmail(body)).find(
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
