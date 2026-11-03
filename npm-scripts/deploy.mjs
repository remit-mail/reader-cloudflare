import { spawnSync } from "node:child_process";
import { backfillTenantAccountConfigs } from "./backfill-tenant-account-config.mjs";
import { inWorkersBuilds, wrangler } from "./cf.mjs";
import { r2ObjectText, resolveAccountId } from "./cf-api.mjs";
import { failOnHits, scanRepo } from "./check-no-config.mjs";
import { migrate } from "./db-migrate.mjs";
import {
  configLiterals,
  DEPLOY_CONFIG_OBJECT,
  parseDeployConfig,
  tofuVars,
} from "./deploy-config.mjs";
import { PROJECT } from "./env.mjs";
import { DEV, PROD } from "./stages.mjs";
import { BUILDER_SECRETS_BUCKET, requireEnv, tofuEnv, tofuInit, tofuRunner } from "./tofu.mjs";
import { WRANGLER_DEPLOY_CONFIG, writeWranglerDeploy } from "./wrangler-config.mjs";

const BUILDER_OBJECTS = [
  "CLOUDFLARE_TOFU_TOKEN",
  "TFSTATE_ACCESS_KEY_ID",
  "TFSTATE_SECRET_ACCESS_KEY",
  DEPLOY_CONFIG_OBJECT,
];

if (!inWorkersBuilds) {
  console.error(
    "npm run deploy is the Workers Builds deploy command and runs only there (WORKERS_CI=1). Push to main to deploy.",
  );
  process.exit(2);
}

if (process.env.WORKERS_CI_BRANCH !== "main") {
  console.error(
    `npm run deploy applies infra and deploys only from main; this build is on ${process.env.WORKERS_CI_BRANCH || "an unknown branch"}. Turn off non-production branch builds.`,
  );
  process.exit(2);
}

delete process.env.WRANGLER_CI_OVERRIDE_NAME;
delete process.env.WRANGLER_CI_MATCH_TAG;

requireEnv(["CLOUDFLARE_API_TOKEN"], "Workers Builds injects it into the deploy step");

const buildsToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = await resolveAccountId(buildsToken);
const objects = {};
for (const key of BUILDER_OBJECTS) {
  const object = await r2ObjectText(buildsToken, accountId, BUILDER_SECRETS_BUCKET, key);
  if (object.status === 404) {
    const flag = key === DEPLOY_CONFIG_OBJECT ? " --config <deploy.config.json>" : "";
    console.error(`${BUILDER_SECRETS_BUCKET} has no ${key}; run tofu-bootstrap ${PROJECT}${flag}`);
    process.exit(1);
  }
  if (!object.ok) {
    console.error(`reading ${key} from ${BUILDER_SECRETS_BUCKET} returned ${object.status}`);
    process.exit(1);
  }
  objects[key] = object.text.trim();
}

const config = parseDeployConfig(
  objects[DEPLOY_CONFIG_OBJECT],
  `r2://${BUILDER_SECRETS_BUCKET}/${DEPLOY_CONFIG_OBJECT}`,
);
if (config.account_id !== accountId) {
  console.error(
    `${DEPLOY_CONFIG_OBJECT} names account ${config.account_id}, the Builds token deploys to ${accountId}`,
  );
  process.exit(1);
}
failOnHits(scanRepo(configLiterals(config)));

const exitOnFailure = (status) => {
  if (status !== 0) process.exit(status);
};

const deployStage = async (stage) => {
  console.log(`deploy: stage ${stage}`);
  const tofu = await tofuRunner(
    tofuEnv({
      accountId,
      apiToken: objects.CLOUDFLARE_TOFU_TOKEN,
      accessKeyId: objects.TFSTATE_ACCESS_KEY_ID,
      secretAccessKey: objects.TFSTATE_SECRET_ACCESS_KEY,
      vars: tofuVars(config, stage),
    }),
  );
  tofu(tofuInit(stage));
  tofu(["apply", "-input=false", "-auto-approve"]);
  const outputs = Object.fromEntries(
    Object.entries(JSON.parse(tofu(["output", "-json"], "pipe"))).map(([name, { value }]) => [
      name,
      value,
    ]),
  );

  const rendered = writeWranglerDeploy(outputs, config, stage);
  console.log(`rendered ${WRANGLER_DEPLOY_CONFIG} for ${rendered.name} on ${outputs.app_hostname}`);

  exitOnFailure(migrate(WRANGLER_DEPLOY_CONFIG, outputs.d1_database_name));
  exitOnFailure(backfillTenantAccountConfigs(WRANGLER_DEPLOY_CONFIG, outputs.d1_database_name));
  exitOnFailure(wrangler(["deploy", "--config", WRANGLER_DEPLOY_CONFIG, ...process.argv.slice(2)]));
  return outputs;
};

const npmRun = (script, env) => {
  const run = spawnSync("npm", ["run", "--silent", script], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (run.error) throw run.error;
  return run.status ?? 1;
};

const dev = await deployStage(DEV);
const devTarget = {
  APP_URL: `https://${dev.app_hostname}`,
  CF_ACCESS_CLIENT_ID: dev.agent_client_id,
  CF_ACCESS_CLIENT_SECRET: dev.agent_client_secret,
};
exitOnFailure(npmRun("seed:dev", devTarget));
exitOnFailure(npmRun("smoke:dev", devTarget));

await deployStage(PROD);
