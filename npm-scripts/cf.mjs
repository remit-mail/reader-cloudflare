import { spawnSync } from "node:child_process";
import { CF_ENV, readEnvFile } from "./env.mjs";

export const inWorkersBuilds = process.env.WORKERS_CI === "1";

export const CLOUDFLARE_VARS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

export const cloudflareEnv = (file = CF_ENV) => {
  const env = { ...process.env };
  const missing = CLOUDFLARE_VARS.filter((name) => !env[name]);
  if (inWorkersBuilds || missing.length === 0) return env;
  const fileEnv = readEnvFile(file);
  for (const name of missing) {
    if (!fileEnv[name]) {
      console.error(`Neither the environment nor ${file} sets ${name}`);
      process.exit(1);
    }
    env[name] = fileEnv[name];
  }
  return env;
};

export const wrangler = (args, file = CF_ENV) => {
  const run = spawnSync("wrangler", args, { env: cloudflareEnv(file), stdio: "inherit" });
  if (run.error) throw run.error;
  return run.status ?? 1;
};

export const wranglerOutput = (args) => {
  const run = spawnSync("wrangler", args, {
    env: cloudflareEnv(),
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`wrangler ${args.join(" ")} exited with ${run.status}`);
  return run.stdout;
};
