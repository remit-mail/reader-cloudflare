import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { pushSecret } from "./dotfiles-secret.mjs";
import { ACCESS_ENV, CONFIG_DIR } from "./env.mjs";
import { debugStateOutputs } from "./state-outputs.mjs";

const { output } = await debugStateOutputs();
const clientId = output("agent_client_id");
const clientSecret = output("agent_client_secret");

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
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
