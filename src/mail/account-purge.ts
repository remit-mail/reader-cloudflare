import type {
  AccountFinalizeEvent,
  AccountPurgeContext,
  DeletionCapabilities,
} from "@remit/account-worker/process";
import type { RemitClient } from "@remit/backend/client";
import {
  runDrizzleAccountConfigErase,
  runDrizzleCascadeDelete,
  type SqliteStores,
} from "@remit/drizzle-service";
import type { Env } from "../env";
import { queueProducer } from "../queue/producer";

const R2_DELETE_LIMIT = 1000;

const deletePrefix = async (bucket: R2Bucket, prefix: string): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list(
      cursor === undefined
        ? { prefix, limit: R2_DELETE_LIMIT }
        : { prefix, cursor, limit: R2_DELETE_LIMIT },
    );
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};

const workersDeletion = (bucket: R2Bucket, stores: SqliteStores): DeletionCapabilities => ({
  assertReady: async () => {},
  // Cloudflare Access owns the session, and content goes out with a private cache-control only.
  signOut: async () => {},
  invalidateContent: async () => {},
  deleteStoragePrefix: (keyPrefix) => deletePrefix(bucket, keyPrefix),
  cascadeDelete: (entities, log) => runDrizzleCascadeDelete(stores, entities, log),
  eraseAccountConfig: (accountConfigId, _services, log) =>
    runDrizzleAccountConfigErase(stores, accountConfigId, log),
  deleteExportArchives: (accountConfigId) => deletePrefix(bucket, `exports/${accountConfigId}/`),
});

export const purgeContext = (
  env: Env,
  tenantId: string,
  client: RemitClient,
  stores: SqliteStores,
): AccountPurgeContext => ({
  client,
  purgeQueue: queueProducer<"Grouped", AccountFinalizeEvent>("Grouped", env, tenantId),
  capabilities: workersDeletion(env.MAIL, stores),
});
