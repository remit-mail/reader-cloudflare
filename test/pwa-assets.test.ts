import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Env } from "../src/env";
import { isPwaAssetPath, PWA_ASSETS, servePwaAsset } from "../src/pwa-assets";

const assets = [
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/sw.js", "application/javascript"],
  ["/apple-touch-icon.png", "image/png"],
  ["/favicon.ico", "image/x-icon"],
  ["/icons/icon-192.png", "image/png"],
  ["/icons/icon-512.png", "image/png"],
  ["/icons/icon-maskable-512.png", "image/png"],
] as const;

const serve = (path: string, asset: Response): Promise<Response> =>
  servePwaAsset(new Request(`https://app.remit.test${path}`), {
    ASSETS: { fetch: async () => asset } as Env["ASSETS"],
  });

describe("installation asset responses", () => {
  it("routes only the seven installation assets", () => {
    assert.deepEqual(PWA_ASSETS, Object.fromEntries(assets));
    for (const [path] of assets) assert.ok(isPwaAssetPath(path));
    for (const path of ["/icons/missing.png", "/icons/future.png", "/assets/app.js", "/toString"]) {
      assert.equal(isPwaAssetPath(path), false);
    }
  });

  it("sets MIME, security and revalidation headers and preserves bytes and ETag", async () => {
    for (const [path, mime] of assets) {
      const response = await serve(
        path,
        new Response("asset", { headers: { ETag: '"revision"' } }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), mime);
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(response.headers.get("Cache-Control"), "no-cache");
      assert.equal(response.headers.get("Service-Worker-Allowed"), path === "/sw.js" ? "/" : null);
      assert.equal(response.headers.get("ETag"), '"revision"');
      assert.equal(await response.text(), "asset");
    }
  });

  it("preserves conditional revalidation responses", async () => {
    const response = await serve("/manifest.webmanifest", new Response(null, { status: 304 }));
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
    assert.equal(await response.text(), "");
  });

  it("replaces missing installation assets' SPA HTML with 404", async () => {
    for (const [path] of assets) {
      const response = await serve(
        path,
        new Response("<html>shell</html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(await response.text(), "");
    }
  });

  it("allows exactly the existing public routes and seven installation assets", () => {
    const infra = readFileSync("infra/access-public.tf", "utf8");
    const block = /public_paths\s*=\s*concat\(\[([^\]]+)\]/.exec(infra)?.[1];
    assert.ok(block);
    const paths = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const expected = [
      "/api/feeds/calendar/*",
      "/api/accounts/oauth/microsoft/callback",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/auth/oauth2/token",
      "/auth/oauth2/register",
      "/auth/oauth2/revoke",
      "/auth/device/code",
      "/auth/jwks",
      "/mcp",
    ].map((path) => `\${var.app_hostname}${path}`);
    assert.deepEqual(paths.sort(), expected.sort());
    assert.ok(
      infra.includes(
        `[for path in keys(jsondecode(file("\${path.module}/../src/pwa-assets.json"))) : "\${var.app_hostname}\${path}"])`,
      ),
    );
  });
});
