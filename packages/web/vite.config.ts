import { webClientPreset } from "@remit/web-client/vite-preset";
import { defineConfig } from "vite";
import { commit } from "../../src/commit.ts";

export default defineConfig(
  webClientPreset({
    entry: "src/main.tsx",
    commit,
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
