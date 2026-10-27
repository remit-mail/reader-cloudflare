import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pushSecret, restoreSecret } from "./dotfiles-secret.mjs";
import { ACCESS_ENV, TFSTATE, TOFU_INIT } from "./env.mjs";

const infraDir = join(dirname(fileURLToPath(import.meta.url)), "..", "infra");

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

restoreSecret("reader-cloudflare-tfstate", TFSTATE, "state");
tofu(TOFU_INIT, "ignore");
const output = (name) => {
  const value = tofu(["output", "-raw", name], "pipe");
  if (!value) {
    console.error(`tofu output ${name} is empty`);
    process.exit(1);
  }
  return value;
};

const clientId = output("agent_client_id");
const clientSecret = output("agent_client_secret");
writeFileSync(
  ACCESS_ENV,
  `CF_ACCESS_CLIENT_ID=${clientId}\nCF_ACCESS_CLIENT_SECRET=${clientSecret}\n`,
  { mode: 0o600 },
);
chmodSync(ACCESS_ENV, 0o600);
console.log(`wrote ${ACCESS_ENV}`);
pushSecret(
  "reader-cloudflare-access-env",
  ACCESS_ENV,
  "access-env",
  "secrets: reader-cloudflare access-env after access-env:write",
);
