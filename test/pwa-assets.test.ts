import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Miniflare } from "miniflare";
import type { Env } from "../src/env";
import { isPwaAssetPath, servePwaAsset } from "../src/pwa-assets";

const assets = [
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/sw.js", "application/javascript"],
  ["/apple-touch-icon.png", "image/png"],
  ["/favicon.ico", "image/x-icon"],
  ["/icons/icon-192.png", "image/png"],
  ["/icons/icon-512.png", "image/png"],
  ["/icons/icon-maskable-512.png", "image/png"],
] as const;

const envWithAsset = (response: Response): Pick<Env, "ASSETS"> => ({
  ASSETS: { fetch: async () => response } as Env["ASSETS"],
});

describe("public installation assets", () => {
  it("preserves conditional revalidation responses", async () => {
    const response = await servePwaAsset(
      new Request("https://app.remit.test/manifest.webmanifest"),
      envWithAsset(new Response(null, { status: 304, headers: { ETag: '"revision"' } })),
    );
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
    assert.equal(response.headers.get("ETag"), '"revision"');
    assert.equal(await response.text(), "");
  });

  it("runs installation requests through the Worker in both environments", () => {
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
    const infra = readFileSync("infra/access-public.tf", "utf8");
    for (const [path] of assets) {
      assert.ok(infra.includes(`"\${var.app_hostname}${path}"`));
      for (const settings of [config.assets, config.env.e2e.assets]) {
        assert.ok(
          settings.run_worker_first.includes(path.startsWith("/icons/") ? "/icons/*" : path),
        );
      }
    }
    assert.equal(isPwaAssetPath("/icons/missing.png"), true);
    for (const path of ["/api/config", "/content/mail", "/assets/app.js", "/mail"]) {
      assert.equal(isPwaAssetPath(path), false);
    }
  });

  it("serves anonymous requests through Workers Assets, including missing navigations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-assets-"));
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
    const script = stripTypeScriptTypes(readFileSync("src/pwa-assets.ts", "utf8"));
    try {
      for (const present of [true, false]) {
        const root = join(directory, String(present));
        mkdirSync(join(root, "icons"), { recursive: true });
        writeFileSync(join(root, "index.html"), "<html>shell</html>");
        if (present) {
          for (const [path] of assets) writeFileSync(join(root, path), "asset");
        }
        const worker = new Miniflare({
          modules: true,
          script: `${script}\nexport default { fetch(request, env) { return isPwaAssetPath(new URL(request.url).pathname) ? servePwaAsset(request, env) : env.ASSETS.fetch(request); } };`,
          compatibilityDate: "2026-08-06",
          assets: {
            directory: root,
            binding: "ASSETS",
            routerConfig: {
              has_user_worker: true,
              static_routing: { user_worker: config.assets.run_worker_first },
            },
            assetConfig: { not_found_handling: config.assets.not_found_handling },
          },
        });
        try {
          for (const [path, mime] of assets) {
            for (const mode of ["cors", "navigate"]) {
              const response = await worker.dispatchFetch(`https://app.remit.test${path}`, {
                headers: { "Sec-Fetch-Mode": mode },
              });
              assert.equal(response.status, present ? 200 : 404, `${path}: ${mode}`);
              assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
              assert.equal(response.headers.get("Cache-Control"), "no-cache");
              if (present) {
                assert.equal(response.headers.get("Content-Type"), mime);
                assert.equal(
                  response.headers.get("Service-Worker-Allowed"),
                  path === "/sw.js" ? "/" : null,
                );
              } else assert.doesNotMatch(await response.text(), /<html>/);
            }
          }
          const missing = await worker.dispatchFetch("https://app.remit.test/icons/missing.png", {
            headers: { "Sec-Fetch-Mode": "navigate" },
          });
          assert.equal(missing.status, 404);
          const navigation = await worker.dispatchFetch("https://app.remit.test/mail", {
            headers: { "Sec-Fetch-Mode": "navigate" },
          });
          assert.equal(navigation.status, 200);
          assert.match(await navigation.text(), /<html>shell<\/html>/);
        } finally {
          await worker.dispose();
        }
      }
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
