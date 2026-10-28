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
  readonly TENANT_MAIL: DurableObjectNamespace<TenantMail>;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly PUBLIC_ORIGIN: string;
  readonly ACCESS_DEV_IDENTITY?: string;
  readonly PLAINTEXT_MAIL_HOSTS?: string;
  readonly MSOAUTH_CLIENT_ID?: string;
  readonly MSOAUTH_CLIENT_SECRET?: SecretsStoreSecret;
  readonly MSOAUTH_TOKEN_ENDPOINT?: string;
  readonly MAIL_HOST_ALIASES?: string;
}

type WorkerEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
