import type { OperatorSettingsService } from "../../../src/operator-settings-contract";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly EMAIL?: SendEmail;
  readonly MAIL_CAPTURE?: string;
  readonly LOGIN_AUTH_SECRET: SecretsStoreSecret;
  readonly LOGIN_ORIGIN: string;
  readonly READER_ORIGIN: string;
  readonly LOGIN_OIDC_CLIENT_ID: string;
  readonly EMAIL_SENDER: string;
  readonly OPERATOR_EMAILS: string;
  readonly OPERATOR_SETTINGS: OperatorSettingsService;
}

type LoginEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends LoginEnv {}
  }
}
