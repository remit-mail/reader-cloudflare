import { buildExportArchiveKey } from "@remit/storage-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { notFound } from "../http";

export const EXPORT_PREFIX = "/exports/";

export const isExportPath = (path: string): boolean => path.startsWith(EXPORT_PREFIX);

export const serveExport = async (
  request: Request,
  env: Env,
  tenant: Tenant,
): Promise<Response> => {
  const key = new URL(request.url).pathname.slice(1);
  const [, , exportRequestId = ""] = key.split("/");
  const headers = { "cache-control": "private, no-store" };
  const archive =
    key === buildExportArchiveKey(tenant.accountConfigId, exportRequestId)
      ? await env.MAIL.get(key)
      : null;
  if (archive === null) {
    const response = notFound("Export");
    response.headers.set("cache-control", headers["cache-control"]);
    return response;
  }
  return new Response(archive.body, {
    headers: {
      ...headers,
      "content-type": archive.httpMetadata?.contentType ?? "application/zip",
      "content-disposition": `attachment; filename="remit-export-${exportRequestId}.zip"`,
      "content-security-policy":
        "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
};
