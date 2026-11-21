import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { webClientPreset } from "@remit/web-client/vite-preset";
import { defineConfig } from "vite";
import { commit } from "../../src/commit.ts";

export default defineConfig(
  webClientPreset({
    entry: "src/main.tsx",
    commit,
    pwa: {
      enabled: true,
      beforePrecache: async (outDir) => {
        await promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../npm-scripts/mcp-pages.ts", import.meta.url)),
          outDir,
        ]);
      },
    },
    runtimeConfig: {
      apiUrl: "/api",
      betterAuthEnabled: false,
      rum: { appMonitorId: "" },
      disableDevtools: true,
      issuesUrl: "https://github.com/remit-mail/reader-cloudflare/issues/new",
      updateMode: "managed",
    },
  }),
);
