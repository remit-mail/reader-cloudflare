import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations({
            migrationsDir: "migrations",
            migrationsPattern: "migrations/{*.sql,*/migration.sql}",
          }),
        },
      },
    }),
  ],
  test: {
    include: ["test/miniflare/*.test.ts"],
    setupFiles: ["./test/miniflare-setup.ts"],
  },
}));
