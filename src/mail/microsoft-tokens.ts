import type { ApiConfig } from "@remit/backend/serve";
import type { TokenService } from "@remit/imap-worker/process";
import { createMailOAuthService, microsoftProviderConfig } from "@remit/mail-oauth-service";
import { apiConfig } from "../api/config";
import { NotComposedError } from "../error-kind";

const unconfigured: TokenService = {
  getAccessToken: () =>
    Promise.reject(
      new NotComposedError("oauth", "the deploy config sets no msoauth Microsoft app"),
    ),
};

export const microsoftTokenService = (msOAuth: ApiConfig["msOAuth"]): TokenService => {
  if (msOAuth.mode === "Disabled") return unconfigured;
  let service: Promise<TokenService> | null = null;
  const load = (): Promise<TokenService> =>
    msOAuth
      .credentials()
      .then(({ clientId, clientSecret }) =>
        createMailOAuthService(
          microsoftProviderConfig({ clientId, clientSecret, overrides: msOAuth.overrides }),
        ),
      );
  return {
    getAccessToken: (cacheKey, refreshToken) => {
      if (service === null) {
        service = load().catch((error: unknown) => {
          service = null;
          throw error;
        });
      }
      return service.then((loaded) => loaded.getAccessToken(cacheKey, refreshToken));
    },
  };
};

export const microsoftTokens = microsoftTokenService(apiConfig.msOAuth);
