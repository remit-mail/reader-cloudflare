import { inWorkersBuilds, wrangler } from "./cf.mjs";
import { r2ObjectText, resolveAccountId } from "./cf-api.mjs";
import { migrate } from "./db-migrate.mjs";
import { BUILDER_SECRETS_BUCKET, requireEnv, TOFU_INIT, tofuEnv, tofuRunner } from "./tofu.mjs";

const BUILDER_SECRETS = [
  "CLOUDFLARE_TOFU_TOKEN",
  "TFSTATE_ACCESS_KEY_ID",
  "TFSTATE_SECRET_ACCESS_KEY",
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

requireEnv(["CLOUDFLARE_API_TOKEN"], "Workers Builds injects it into the deploy step");

const buildsToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = await resolveAccountId(buildsToken);
const secrets = {};
for (const key of BUILDER_SECRETS) {
  const object = await r2ObjectText(buildsToken, accountId, BUILDER_SECRETS_BUCKET, key);
  if (object.status === 404) {
    console.error(`${BUILDER_SECRETS_BUCKET} has no ${key}; run tofu-bootstrap reader-cloudflare`);
    process.exit(1);
  }
  if (!object.ok) {
    console.error(`reading ${key} from ${BUILDER_SECRETS_BUCKET} returned ${object.status}`);
    process.exit(1);
  }
  secrets[key] = object.text.trim();
}

const tofu = await tofuRunner(
  tofuEnv({
    accountId,
    apiToken: secrets.CLOUDFLARE_TOFU_TOKEN,
    accessKeyId: secrets.TFSTATE_ACCESS_KEY_ID,
    secretAccessKey: secrets.TFSTATE_SECRET_ACCESS_KEY,
  }),
);
tofu(TOFU_INIT);
tofu(["apply", "-input=false", "-auto-approve"]);

const migrated = await migrate();
if (migrated !== 0) process.exit(migrated);
process.exit(wrangler(["deploy", ...process.argv.slice(2)]));
