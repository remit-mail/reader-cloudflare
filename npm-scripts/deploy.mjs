import { inWorkersBuilds, wrangler } from "./cf.mjs";
import { resolveAccountId } from "./cf-api.mjs";
import { migrate } from "./db-migrate.mjs";
import { requireEnv, TOFU_INIT, tofuEnv, tofuRunner } from "./tofu.mjs";

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

requireEnv(
  [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_TOFU_TOKEN",
    "TFSTATE_ACCESS_KEY_ID",
    "TFSTATE_SECRET_ACCESS_KEY",
  ],
  "set them as Workers Builds build variables from tofu-bootstrap reader-cloudflare",
);

const tofu = await tofuRunner(
  tofuEnv({
    accountId: await resolveAccountId(process.env.CLOUDFLARE_TOFU_TOKEN),
    apiToken: process.env.CLOUDFLARE_TOFU_TOKEN,
    accessKeyId: process.env.TFSTATE_ACCESS_KEY_ID,
    secretAccessKey: process.env.TFSTATE_SECRET_ACCESS_KEY,
  }),
);
tofu(TOFU_INIT);
tofu(["apply", "-input=false", "-auto-approve"]);

const migrated = await migrate();
if (migrated !== 0) process.exit(migrated);
process.exit(wrangler(["deploy", ...process.argv.slice(2)]));
