import { spawnSync } from "node:child_process";
import { CF_ENV, readEnvFile } from "./env.mjs";

export const inWorkersBuilds = process.env.WORKERS_CI === "1";

export const cloudflareEnv = () => {
  const env = { ...process.env };
  if (inWorkersBuilds) return env;
  const fileEnv = readEnvFile(CF_ENV);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!fileEnv[name]) {
      console.error(`${CF_ENV} does not set ${name}`);
      process.exit(1);
    }
    env[name] = fileEnv[name];
  }
  return env;
};

export const wrangler = (args) => {
  const run = spawnSync("wrangler", args, { env: cloudflareEnv(), stdio: "inherit" });
  if (run.error) throw run.error;
  return run.status ?? 1;
};
