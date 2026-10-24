import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CF_ENV, readEnvFile, TOFU_INIT } from "./env.mjs";

const infraDir = join(dirname(fileURLToPath(import.meta.url)), "..", "infra");
const [command, ...args] = process.argv.slice(2);

if (command !== "plan" && command !== "apply") {
  console.error("usage: node npm-scripts/infra.mjs <plan|apply> [tofu args]");
  process.exit(2);
}

const fileEnv = readEnvFile(CF_ENV);
if (!fileEnv.CLOUDFLARE_API_TOKEN) {
  console.error(`${CF_ENV} does not set CLOUDFLARE_API_TOKEN`);
  process.exit(1);
}

const env = { ...process.env, CLOUDFLARE_API_TOKEN: fileEnv.CLOUDFLARE_API_TOKEN };
const tofu = (...tofuArgs) => {
  const run = spawnSync("tofu", tofuArgs, { cwd: infraDir, env, stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
};

tofu(...TOFU_INIT);
tofu(command, "-input=false", ...args);
