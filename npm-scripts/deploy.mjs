import { inWorkersBuilds, wrangler } from "./cf.mjs";
import { migrate } from "./db-migrate.mjs";

if (!inWorkersBuilds) {
  console.error(
    "npm run deploy is the Workers Builds deploy command and runs only there (WORKERS_CI=1). Push to main to deploy.",
  );
  process.exit(2);
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error(`Workers Builds did not set CLOUDFLARE_API_TOKEN in the deploy step`);
  process.exit(1);
}

const migrated = await migrate();
if (migrated !== 0) process.exit(migrated);
process.exit(wrangler(["deploy", ...process.argv.slice(2)]));
