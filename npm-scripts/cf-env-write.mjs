import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CF_BOOTSTRAP_ENV, CF_ENV, readEnvFile, TOFU_INIT } from "./env.mjs";

const infraDir = join(dirname(fileURLToPath(import.meta.url)), "..", "infra");

const accountId = readEnvFile(CF_BOOTSTRAP_ENV).CLOUDFLARE_ACCOUNT_ID;
if (!accountId) {
  console.error(`${CF_BOOTSTRAP_ENV} does not set CLOUDFLARE_ACCOUNT_ID`);
  process.exit(1);
}

const tofu = (args, stdout) => {
  const run = spawnSync("tofu", args, {
    cwd: infraDir,
    stdio: ["ignore", stdout, "inherit"],
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    console.error(`tofu ${args[0]} exited with ${run.status}`);
    process.exit(run.status ?? 1);
  }
  return run.stdout;
};

tofu(TOFU_INIT, "ignore");
const tokenOutput = (name) => {
  const token = tofu(["output", "-raw", name], "pipe");
  if (!token) {
    console.error(`tofu output ${name} is empty`);
    process.exit(1);
  }
  return token;
};

const writeEnv = (path, token) => {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.previous`);
    chmodSync(`${path}.previous`, 0o600);
  }
  writeFileSync(path, `CLOUDFLARE_API_TOKEN=${token}\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  console.log(`wrote ${path}`);
};

writeEnv(CF_ENV, tokenOutput("debug_token"));
