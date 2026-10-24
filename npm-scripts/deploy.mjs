import { spawnSync } from "node:child_process";
import { CF_ENV, readEnvFile } from "./env.mjs";

const args = process.argv.slice(2);
const bootstrap = args.includes("--bootstrap");
const inWorkersBuilds = process.env.WORKERS_CI === "1";

if (!inWorkersBuilds && !bootstrap) {
  console.error(
    "Workers Builds deploys reader-cloudflare on push to main. Pass --bootstrap only for a deploy before Workers Builds has run.",
  );
  process.exit(2);
}

const env = { ...process.env };
if (!inWorkersBuilds) {
  const fileEnv = readEnvFile(CF_ENV);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!fileEnv[name]) {
      console.error(`${CF_ENV} does not set ${name}`);
      process.exit(1);
    }
    env[name] = fileEnv[name];
  }
}

const run = spawnSync("wrangler", ["deploy", ...args.filter((arg) => arg !== "--bootstrap")], {
  env,
  stdio: "inherit",
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
