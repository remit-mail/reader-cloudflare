import { webClientPreset } from "@remit/web-client/vite-preset";
import { defineConfig } from "vite";
import { copyMcpPageAssets } from "../../npm-scripts/mcp-pages.ts";
import { commit } from "../../src/commit.ts";

export default defineConfig(
  webClientPreset({
    entry: "src/main.tsx",
    commit,
    pwa: {
      enabled: true,
      navigationDenylist: ["/consent", "/device", "/apps"],
      beforePrecache: copyMcpPageAssets,
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
