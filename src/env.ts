import type { LoginMailReader } from "./login-mail";
import type { TenantMail } from "./mail/tenant-mail";
import type { QueueEnvelope } from "./queue/routing";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly MAIL: R2Bucket;
  readonly SYNC: Queue<QueueEnvelope>;
  readonly MUTATION_QUEUE: Queue<QueueEnvelope>;
  readonly SMTP_QUEUE: Queue<QueueEnvelope>;
  readonly FANOUT_QUEUE: Queue<QueueEnvelope>;
  readonly BODY_QUEUE: Queue<QueueEnvelope>;
  readonly MASTER_KEY: SecretsStoreSecret;
  readonly MCP_AUTH_SECRET: SecretsStoreSecret;
  readonly TENANT_MAIL: DurableObjectNamespace<TenantMail>;
  readonly TENANT_RATE_LIMIT: RateLimit;
  readonly CALENDAR_FEED_RATE_LIMIT: RateLimit;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly PUBLIC_ORIGIN: string;
  readonly ACCESS_DEV_IDENTITY?: string;
  readonly PLAINTEXT_MAIL_HOSTS?: string;
  readonly MSOAUTH_CLIENT_ID?: string;
  readonly MSOAUTH_CLIENT_SECRET?: SecretsStoreSecret;
  readonly MSOAUTH_OVERRIDES?: string;
  readonly CLASSIFICATION_DEFAULT_PRESET?: string;
  readonly CLASSIFICATION_DEFAULT_API_KEY?: SecretsStoreSecret;
  readonly LOGIN_MAIL?: LoginMailReader;
  readonly LOGIN_MAIL_READER?: string;
}

type WorkerEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
