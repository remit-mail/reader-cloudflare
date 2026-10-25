import { cpSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { webClientPreset } from "@remit/web-client/vite-preset";
import { defineConfig, type Plugin } from "vite";
import { commit } from "../../src/commit.ts";

const outDir = resolve(import.meta.dirname, "dist");
const webClientPublic = join(
  dirname(createRequire(import.meta.url).resolve("@remit/web-client/vite-preset")),
  "..",
  "public",
);

const webClientAssets = (): Plugin => ({
  name: "web-client-public-assets",
  apply: "build",
  writeBundle() {
    for (const entry of readdirSync(webClientPublic)) {
      if (entry === "config.js") continue;
      cpSync(join(webClientPublic, entry), join(outDir, entry), { recursive: true });
    }
  },
});

const preset = webClientPreset();

export default defineConfig({
  ...preset,
  plugins: [...(preset.plugins ?? []), webClientAssets()],
  define: { ...preset.define, __APP_SHA__: JSON.stringify(commit) },
  build: { ...preset.build, outDir, emptyOutDir: true },
});
