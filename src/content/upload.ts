import { parseOutboxAttachmentKey, UPLOAD_ROUTE_PREFIX } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { apiError, notFound } from "../http";

export const isUploadPath = (path: string): boolean => path.startsWith(UPLOAD_ROUTE_PREFIX);

export const serveUpload = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  if (request.method !== "PUT") {
    return apiError(405, "MethodNotAllowed", "Upload an attachment with PUT");
  }
  const key = new URL(request.url).pathname.slice(UPLOAD_ROUTE_PREFIX.length);
  const target = parseOutboxAttachmentKey(key);
  if (target === null || target.accountConfigId !== tenant.accountConfigId) {
    return notFound("Upload target");
  }
  const contentType = request.headers.get("content-type");
  await env.MAIL.put(
    key,
    request.body,
    contentType === null ? {} : { httpMetadata: { contentType } },
  );
  return new Response(null, { status: 204 });
};
