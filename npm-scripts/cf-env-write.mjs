import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { pushSecret } from "./dotfiles-secret.mjs";
import { CF_ENV, CONFIG_DIR, DEBUG_TOKEN_SECRET } from "./env.mjs";
import { debugStateOutputs } from "./state-outputs.mjs";

const { accountId, output } = await debugStateOutputs();
const token = output("debug_token");

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
if (existsSync(CF_ENV)) {
  copyFileSync(CF_ENV, `${CF_ENV}.previous`);
  chmodSync(`${CF_ENV}.previous`, 0o600);
}
writeFileSync(CF_ENV, `CLOUDFLARE_API_TOKEN=${token}\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`, {
  mode: 0o600,
});
chmodSync(CF_ENV, 0o600);
console.log(`wrote ${CF_ENV}`);
pushSecret(
  DEBUG_TOKEN_SECRET,
  CF_ENV,
  "cf-env",
  "secrets: reader-cloudflare cf-env after cf-env:write",
);
