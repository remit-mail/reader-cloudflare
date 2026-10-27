import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrangler } from "./cf.mjs";
import { readJsonc, WRANGLER_DEPLOY_CONFIG } from "./wrangler-config.mjs";

export const migrate = (config, database) =>
  wrangler(["d1", "migrations", "apply", database, "--remote", "--config", config]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(WRANGLER_DEPLOY_CONFIG)) {
    console.error(
      `${WRANGLER_DEPLOY_CONFIG} is missing; npm run deploy renders it in Workers Builds, which applies migrations`,
    );
    process.exit(1);
  }
  const [database] = readJsonc(WRANGLER_DEPLOY_CONFIG).d1_databases;
  process.exit(migrate(WRANGLER_DEPLOY_CONFIG, database.database_name));
}
