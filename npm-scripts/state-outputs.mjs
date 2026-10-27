import { r2Credentials, resolveAccountId } from "./cf-api.mjs";
import { restoreSecret } from "./dotfiles-secret.mjs";
import { CF_ENV, DEBUG_TOKEN_SECRET, readEnvFile } from "./env.mjs";
import { readStateOutputs } from "./tofu.mjs";

const stateCredentials = async (token, accountId) => {
  const { TFSTATE_ACCESS_KEY_ID, TFSTATE_SECRET_ACCESS_KEY } = process.env;
  if (TFSTATE_ACCESS_KEY_ID && TFSTATE_SECRET_ACCESS_KEY) {
    return { accessKeyId: TFSTATE_ACCESS_KEY_ID, secretAccessKey: TFSTATE_SECRET_ACCESS_KEY };
  }
  return r2Credentials(token, accountId);
};

export const debugStateOutputs = async () => {
  restoreSecret(DEBUG_TOKEN_SECRET, CF_ENV, "cf-env");
  const fileEnv = readEnvFile(CF_ENV);
  const token = fileEnv.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error(`${CF_ENV} does not set CLOUDFLARE_API_TOKEN`);
    process.exit(1);
  }
  const accountId = fileEnv.CLOUDFLARE_ACCOUNT_ID || (await resolveAccountId(token));
  const credentials = await stateCredentials(token, accountId);
  return { accountId, output: await readStateOutputs({ accountId, ...credentials }) };
};
