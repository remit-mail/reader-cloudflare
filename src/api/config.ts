import { env } from "cloudflare:workers";
import { type MsOAuthOverrides, microsoftTokenService } from "@remit/backend/msoauth";
import type { ApiConfig } from "@remit/backend/serve";
import { z } from "zod";
import { commit } from "../commit";
import { MICROSOFT_OAUTH_CALLBACK } from "./paths";

const NO_UPDATE_CONTROL = "";

const mailServer = z.object({
  host: z.string(),
  port: z.number().int(),
  tls: z.boolean(),
  startTls: z.boolean(),
});

const overridesSchema = z
  .object({
    tokenEndpoint: z.string().url().optional(),
    imapServer: mailServer.optional(),
    smtpServer: mailServer.optional(),
  })
  .strict();

const msOAuthOverrides = (): MsOAuthOverrides => {
  if (env.MSOAUTH_OVERRIDES === undefined) return {};
  const { tokenEndpoint, imapServer, smtpServer } = overridesSchema.parse(
    JSON.parse(env.MSOAUTH_OVERRIDES),
  );
  return {
    ...(tokenEndpoint !== undefined && { tokenEndpoint }),
    ...(imapServer !== undefined && { imapServer }),
    ...(smtpServer !== undefined && { smtpServer }),
  };
};

const msOAuth = (): ApiConfig["msOAuth"] => {
  const clientId = env.MSOAUTH_CLIENT_ID;
  const clientSecret = env.MSOAUTH_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) return { mode: "Disabled" };
  return {
    mode: "Enabled",
    redirectUri: `${env.PUBLIC_ORIGIN}${MICROSOFT_OAUTH_CALLBACK}`,
    overrides: msOAuthOverrides(),
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

export const microsoftTokens = microsoftTokenService(apiConfig.msOAuth);
