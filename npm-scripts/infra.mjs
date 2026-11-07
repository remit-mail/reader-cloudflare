import { resolveAccountId } from "./cf-api.mjs";
import { fetchBuildsDeployConfig, readDeploySecrets, tofuVars } from "./deploy-config.mjs";
import { PROJECT } from "./env.mjs";
import { parseStage } from "./stages.mjs";
import { requireEnv, tofuEnv, tofuInit, tofuRunner } from "./tofu.mjs";

requireEnv(
  ["CLOUDFLARE_TOFU_TOKEN", "TFSTATE_ACCESS_KEY_ID", "TFSTATE_SECRET_ACCESS_KEY"],
  `export them from dotfiles-key decrypt ${PROJECT}-tofu-token and ${PROJECT}-tfstate-s3; applies run only in Workers Builds`,
);

const args = process.argv.slice(2);
const stageArg = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
const stage = parseStage(stageArg);
const planArgs = stageArg ? args.slice(1) : args;

const builds = fetchBuildsDeployConfig();
if (!builds.fetched) {
  console.error(builds.reason);
  process.exit(1);
}
const plain = builds.config;

const token = process.env.CLOUDFLARE_TOFU_TOKEN;
const accountId = await resolveAccountId(token);
const config = { ...plain, ...(await readDeploySecrets(token, accountId)) };

const tofu = await tofuRunner(
  tofuEnv({
    accountId,
    apiToken: token,
    accessKeyId: process.env.TFSTATE_ACCESS_KEY_ID,
    secretAccessKey: process.env.TFSTATE_SECRET_ACCESS_KEY,
    vars: tofuVars(config, stage),
  }),
);
tofu(tofuInit(stage));
tofu(["plan", "-input=false", ...planArgs]);
