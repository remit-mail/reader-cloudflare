export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly EMAIL: SendEmail;
  readonly LOGIN_AUTH_SECRET: SecretsStoreSecret;
  readonly LOGIN_ORIGIN: string;
  readonly READER_ORIGIN: string;
  readonly LOGIN_OIDC_CLIENT_ID: string;
  readonly EMAIL_SENDER: string;
  readonly OPERATOR_EMAILS: string;
}

type LoginEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends LoginEnv {}
  }
}
