import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAccountId } from "./cf-api.mjs";
import {
  BUILDS_BOOTSTRAP_PROJECTS,
  BUILDS_BOOTSTRAP_REPO,
  DEPLOY_CONFIG_FILE,
  parseDeployConfig,
  readDeploySecrets,
  tofuVars,
} from "./deploy-config.mjs";
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

const fetched = spawnSync(
  "gh",
  [
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${BUILDS_BOOTSTRAP_REPO}/contents/${BUILDS_BOOTSTRAP_PROJECTS}`,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (fetched.error) throw fetched.error;
if (fetched.status !== 0) {
  console.error(`gh api could not read ${BUILDS_BOOTSTRAP_PROJECTS} from ${BUILDS_BOOTSTRAP_REPO}`);
  process.exit(1);
}
const entry = Object.values(JSON.parse(fetched.stdout).projects).find(
  (project) => project.worker === PROJECT,
);
const deployConfig = entry?.environment?.DEPLOY_CONFIG;
if (!deployConfig) {
  console.error(`${BUILDS_BOOTSTRAP_REPO} sets no DEPLOY_CONFIG for the Worker ${PROJECT}`);
  process.exit(1);
}
const source = `${BUILDS_BOOTSTRAP_REPO}/${BUILDS_BOOTSTRAP_PROJECTS}`;
const plain = parseDeployConfig(deployConfig, source);
mkdirSync(dirname(DEPLOY_CONFIG_FILE), { recursive: true, mode: 0o700 });
writeFileSync(DEPLOY_CONFIG_FILE, `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 });

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
