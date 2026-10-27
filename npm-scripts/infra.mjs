import { readFileSync } from "node:fs";
import { resolveAccountId } from "./cf-api.mjs";
import {
  DEPLOY_CONFIG_FILE,
  DEPLOY_CONFIG_SECRET,
  parseDeployConfig,
  tofuVars,
} from "./deploy-config.mjs";
import { restoreSecret } from "./dotfiles-secret.mjs";
import { PROJECT } from "./env.mjs";
import { requireEnv, TOFU_INIT, tofuEnv, tofuRunner } from "./tofu.mjs";

requireEnv(
  ["CLOUDFLARE_TOFU_TOKEN", "TFSTATE_ACCESS_KEY_ID", "TFSTATE_SECRET_ACCESS_KEY"],
  `export them from dotfiles-key decrypt ${PROJECT}-tofu-token and ${PROJECT}-tfstate-s3; applies run only in Workers Builds`,
);

restoreSecret(DEPLOY_CONFIG_SECRET, DEPLOY_CONFIG_FILE, "deploy config");
const config = parseDeployConfig(readFileSync(DEPLOY_CONFIG_FILE, "utf8"), DEPLOY_CONFIG_FILE);

const tofu = await tofuRunner(
  tofuEnv({
    accountId: await resolveAccountId(process.env.CLOUDFLARE_TOFU_TOKEN),
    apiToken: process.env.CLOUDFLARE_TOFU_TOKEN,
    accessKeyId: process.env.TFSTATE_ACCESS_KEY_ID,
    secretAccessKey: process.env.TFSTATE_SECRET_ACCESS_KEY,
    vars: tofuVars(config),
  }),
);
tofu(TOFU_INIT);
tofu(["plan", "-input=false", ...process.argv.slice(2)]);
