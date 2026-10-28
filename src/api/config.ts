import { env } from "cloudflare:workers";
import type { ApiConfig } from "@remit/backend/serve";
import { commit } from "../commit";
import { MICROSOFT_OAUTH_CALLBACK } from "./paths";

const NO_UPDATE_CONTROL = "";

const msOAuth = (): ApiConfig["msOAuth"] => {
  const clientId = env.MSOAUTH_CLIENT_ID;
  const clientSecret = env.MSOAUTH_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) return { mode: "Disabled" };
  return {
    mode: "Enabled",
    redirectUri: `${env.PUBLIC_ORIGIN}${MICROSOFT_OAUTH_CALLBACK}`,
    overrides:
      env.MSOAUTH_TOKEN_ENDPOINT === undefined ? {} : { tokenEndpoint: env.MSOAUTH_TOKEN_ENDPOINT },
    credentials: async () => ({ clientId, clientSecret: await clientSecret.get() }),
  };
};

export const apiConfig: ApiConfig = {
  auth: { mode: "GatewayAuthorizer" },
  corsAllowedOrigins: [env.PUBLIC_ORIGIN],
  publicOrigin: env.PUBLIC_ORIGIN,
  contentDeliveryDomain: env.PUBLIC_ORIGIN,
  msOAuth: msOAuth(),
  selfUpdate: "Disabled",
  updateControlDir: NO_UPDATE_CONTROL,
  commit,
  responseValidation: "Skip",
};
