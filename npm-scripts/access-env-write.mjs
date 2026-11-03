import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { pushSecret } from "./dotfiles-secret.mjs";
import { accessEnvOf, accessEnvSecretOf, CONFIG_DIR, PROJECT } from "./env.mjs";
import { parseStage } from "./stages.mjs";
import { debugStateOutputs } from "./state-outputs.mjs";

const stage = parseStage(process.argv[2]);
const accessEnv = accessEnvOf(stage);
const { output } = await debugStateOutputs(stage);
const clientId = output("agent_client_id");
const clientSecret = output("agent_client_secret");
const appUrl = `https://${output("app_hostname")}`;

mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
writeFileSync(
  accessEnv,
  `APP_URL=${appUrl}\nCF_ACCESS_CLIENT_ID=${clientId}\nCF_ACCESS_CLIENT_SECRET=${clientSecret}\n`,
  { mode: 0o600 },
);
chmodSync(accessEnv, 0o600);
console.log(`wrote ${accessEnv}`);
pushSecret(
  accessEnvSecretOf(stage),
  accessEnv,
  "access-env",
  `secrets: ${PROJECT} ${stage} access-env after access-env:write`,
);
