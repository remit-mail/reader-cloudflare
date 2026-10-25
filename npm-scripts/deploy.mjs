import { inWorkersBuilds, wrangler } from "./cf.mjs";
import { migrate } from "./db-migrate.mjs";

const args = process.argv.slice(2);
const bootstrap = args.includes("--bootstrap");

if (!inWorkersBuilds && !bootstrap) {
  console.error(
    "Workers Builds deploys reader-cloudflare on push to main. Pass --bootstrap only for a deploy before Workers Builds has run.",
  );
  process.exit(2);
}

const migrated = await migrate();
if (migrated !== 0) process.exit(migrated);
process.exit(wrangler(["deploy", ...args.filter((arg) => arg !== "--bootstrap")]));
