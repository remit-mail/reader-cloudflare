import type { TenantMail } from "./mail/tenant-mail";
import type { AccountSync } from "./sync/account-sync";
import type { SyncMessage } from "./sync/messages";

export type { SyncMessage };

export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly MAIL: R2Bucket;
  readonly SYNC: Queue<SyncMessage>;
  readonly MUTATION_QUEUE: Queue<unknown>;
  readonly SMTP_QUEUE: Queue<unknown>;
  readonly FANOUT_QUEUE: Queue<unknown>;
  readonly MASTER_KEY: SecretsStoreSecret;
  readonly TENANT_MAIL: DurableObjectNamespace<TenantMail>;
  readonly ACCOUNT_SYNC: DurableObjectNamespace<AccountSync>;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly PUBLIC_ORIGIN: string;
  readonly ACCESS_DEV_IDENTITY?: string;
  readonly PLAINTEXT_MAIL_HOSTS?: string;
}

type WorkerEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
