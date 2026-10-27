import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pushSecret, restoreSecret } from "./dotfiles-secret.mjs";
import { CF_BOOTSTRAP_ENV, readEnvFile, TFSTATE, TOFU_INIT } from "./env.mjs";

const infraDir = join(dirname(fileURLToPath(import.meta.url)), "..", "infra");
const [command, ...args] = process.argv.slice(2);

if (command !== "plan" && command !== "apply") {
  console.error("usage: node npm-scripts/infra.mjs <plan|apply> [tofu args]");
  process.exit(2);
}

restoreSecret("reader-cloudflare-tfstate", TFSTATE, "state");

const fileEnv = readEnvFile(CF_BOOTSTRAP_ENV);
for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!fileEnv[name]) {
    console.error(`${CF_BOOTSTRAP_ENV} does not set ${name}`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: fileEnv.CLOUDFLARE_API_TOKEN,
  TF_VAR_account_id: fileEnv.CLOUDFLARE_ACCOUNT_ID,
};
const tofu = (...tofuArgs) => {
  const run = spawnSync("tofu", tofuArgs, { cwd: infraDir, env, stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
};

tofu(...TOFU_INIT);
tofu(command, "-input=false", ...args);
if (command === "apply") {
  pushSecret(
    "reader-cloudflare-tfstate",
    TFSTATE,
    "state",
    "secrets: reader-cloudflare tfstate after infra:apply",
  );
}
