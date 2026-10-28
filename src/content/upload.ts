import {
  authorizeUploadRequest,
  parseOutboxAttachmentKey,
  UPLOAD_ROUTE_PREFIX,
} from "@remit/storage-service";
import type { Tenant } from "../access";
import type { UploadUrls } from "../api/storage";
import type { Env } from "../env";
import { apiError, notFound } from "../http";

export const isUploadPath = (path: string): boolean => path.startsWith(UPLOAD_ROUTE_PREFIX);

export const uploadUrls = (env: Env): UploadUrls => ({
  origin: env.PUBLIC_ORIGIN.replace(/\/+$/, ""),
  signingSecret: () => env.MASTER_KEY.get(),
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const serveUpload = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  if (request.method !== "PUT") {
    return apiError(405, "MethodNotAllowed", "Upload an attachment with PUT");
  }
  const url = new URL(request.url);
  const key = url.pathname.slice(UPLOAD_ROUTE_PREFIX.length);
  const target = parseOutboxAttachmentKey(key);
  if (target === null || target.accountConfigId !== tenant.accountConfigId) {
    return notFound("Upload target");
  }
  const decision = authorizeUploadRequest({
    secret: await env.MASTER_KEY.get(),
    relativePath: key,
    exp: url.searchParams.get("exp") ?? undefined,
    max: url.searchParams.get("max") ?? undefined,
    sig: url.searchParams.get("sig") ?? undefined,
    nowSeconds: nowSeconds(),
  });
  if (!decision.authorized) {
    return apiError(decision.status, "UploadRefused", `Attach the file again: ${decision.reason}`);
  }
  const declared = Number(request.headers.get("content-length"));
  if (request.body === null || declared !== decision.maxBytes) {
    return apiError(
      400,
      "SizeMismatch",
      `This upload carries ${decision.maxBytes} bytes; the request declared ${declared}`,
    );
  }
  const contentType = request.headers.get("content-type");
  await env.MAIL.put(
    key,
    request.body,
    contentType === null ? {} : { httpMetadata: { contentType } },
  );
  return new Response(null, { status: 204 });
};
