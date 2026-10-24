import type { TenantMail } from "./mail/tenant-mail";
import type { TenantSearch } from "./search/tenant-search";
import type { SyncMessage } from "./sync/messages";

export type { SyncMessage };

export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly MAIL: R2Bucket;
  readonly SYNC: Queue<SyncMessage>;
  readonly MASTER_KEY: SecretsStoreSecret;
  readonly TENANT_MAIL: DurableObjectNamespace<TenantMail>;
  readonly TENANT_SEARCH: DurableObjectNamespace<TenantSearch>;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
}
