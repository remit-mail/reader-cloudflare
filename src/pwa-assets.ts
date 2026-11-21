import type { Env } from "./env";

export const isPwaAssetPath = (path: string): boolean =>
  path === "/sw.js" ||
  path === "/manifest.webmanifest" ||
  path === "/apple-touch-icon.png" ||
  path === "/favicon.ico" ||
  path.startsWith("/icons/");

export const servePwaAsset = async (
  request: Request,
  env: Pick<Env, "ASSETS">,
): Promise<Response> => {
  const path = new URL(request.url).pathname;
  const asset = await env.ASSETS.fetch(request);
  // Assets applies the SPA fallback even through its binding. Never serve that
  // HTML as an installation asset, including when opened as a navigation.
  const response = asset.headers.get("Content-Type")?.startsWith("text/html")
    ? new Response(null, { status: 404 })
    : new Response(asset.body, asset);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "no-cache");
  if (response.ok || response.status === 304) {
    response.headers.set(
      "Content-Type",
      path === "/sw.js"
        ? "application/javascript"
        : path === "/manifest.webmanifest"
          ? "application/manifest+json"
          : path === "/favicon.ico"
            ? "image/x-icon"
            : "image/png",
    );
    if (path === "/sw.js") response.headers.set("Service-Worker-Allowed", "/");
  }
  return response;
};
