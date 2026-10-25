import { env } from "cloudflare:workers";
import type { ApiConfig } from "@remit/backend/serve";
import { commit } from "../commit";

const NO_UPDATE_CONTROL = "";

export const apiConfig: ApiConfig = {
  auth: { mode: "GatewayAuthorizer" },
  corsAllowedOrigins: [env.PUBLIC_ORIGIN],
  publicOrigin: env.PUBLIC_ORIGIN,
  contentDeliveryDomain: new URL(env.PUBLIC_ORIGIN).host,
  msOAuth: { mode: "Disabled" },
  selfUpdate: "Disabled",
  updateControlDir: NO_UPDATE_CONTROL,
  commit,
  responseValidation: "Skip",
};
