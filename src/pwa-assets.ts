import type { Env } from "./env";
import PWA_ASSETS from "./pwa-assets.json";

export { PWA_ASSETS };

export const isPwaAssetPath = (path: string): path is keyof typeof PWA_ASSETS =>
  Object.hasOwn(PWA_ASSETS, path);

export const servePwaAsset = async (
  request: Request,
  env: Pick<Env, "ASSETS">,
): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (!isPwaAssetPath(path)) return new Response(null, { status: 404 });
  const asset = await env.ASSETS.fetch(request);
  // Assets applies the SPA fallback even through its binding. Never serve that
  // HTML as an installation asset, including when opened as a navigation.
  const response = asset.headers.get("Content-Type")?.startsWith("text/html")
    ? new Response(null, { status: 404 })
    : new Response(asset.body, asset);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "no-cache");
  if (response.ok || response.status === 304) {
    response.headers.set("Content-Type", PWA_ASSETS[path]);
    if (path === "/sw.js") response.headers.set("Service-Worker-Allowed", "/");
  }
  return response;
};
