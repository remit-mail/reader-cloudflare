export interface SyncMessage {
  readonly kind: string;
}

export interface Env {
  readonly DB: D1Database;
  readonly MAIL: R2Bucket;
  readonly SYNC: Queue<SyncMessage>;
  readonly MASTER_KEY: SecretsStoreSecret;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
}
