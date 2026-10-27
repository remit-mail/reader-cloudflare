import { resolveAccountId } from "./cf-api.mjs";
import { requireEnv, TOFU_INIT, tofuEnv, tofuRunner } from "./tofu.mjs";

requireEnv(
  ["CLOUDFLARE_TOFU_TOKEN", "TFSTATE_ACCESS_KEY_ID", "TFSTATE_SECRET_ACCESS_KEY"],
  "export them from dotfiles-key decrypt reader-cloudflare-tofu-token and reader-cloudflare-tfstate-s3; applies run only in Workers Builds",
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
tofu(["plan", "-input=false", ...process.argv.slice(2)]);
