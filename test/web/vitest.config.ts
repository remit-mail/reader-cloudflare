import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Exercise the published recovery control, which has no public subpath export.
const clientSource = new URL("../", import.meta.resolve("@remit/web-client/auth/provider"));

export default defineConfig({
  resolve: {
    alias: {
      "@reader-recovery": fileURLToPath(new URL("components/ui/SignedOutOverlay.js", clientSource)),
      "@reader-signed-out": fileURLToPath(new URL("lib/signed-out.js", clientSource)),
    },
  },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    server: { deps: { inline: [/@remit\/(?:ui|web-client)/] } },
    environmentOptions: { jsdom: { url: "https://app.remit.test/mail/inbox?thread=kept#message" } },
    include: ["test/web/*.test.ts"],
  },
});
