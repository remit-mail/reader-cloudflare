import type {
  AccountFinalizeEvent,
  AccountPurgeContext,
  DeletionCapabilities,
} from "@remit/account-worker/process";
import type { RemitClient } from "@remit/backend/client";
import {
  accountIdsOf,
  eraseAccountConfigAppRows,
  runDrizzleCascadeDelete,
  type SqliteStores,
} from "@remit/drizzle-service";
import { eraseTenantRows } from "../db/tenant-erase";
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

// The tenant object holds one account config's mail and nothing else, so erasing
// it wipes the object's storage instead of deleting its rows one by one.
const workersDeletion = (
  bucket: R2Bucket,
  tenantId: string,
  stores: SqliteStores,
  wipeTenantObject: () => Promise<void>,
): DeletionCapabilities => ({
  assertReady: async () => {},
  // Cloudflare Access owns the session, and content goes out with a private cache-control only.
  signOut: async () => {},
  invalidateContent: async () => {},
  deleteStoragePrefix: (keyPrefix) => deletePrefix(bucket, keyPrefix),
  cascadeDelete: (entities, log) => runDrizzleCascadeDelete(stores, entities, log),
  // D1 goes first: once the tenant rows are gone no scheduler tick or sync can
  // refill the object between its wipe and a retry.
  eraseAccountConfig: async (accountConfigId) => {
    const accountIds = await accountIdsOf(stores.app, accountConfigId);
    await eraseAccountConfigAppRows(stores.app, accountConfigId, accountIds);
    await eraseTenantRows(stores.app, tenantId);
    await wipeTenantObject();
  },
});

export const purgeContext = (
  env: Env,
  tenantId: string,
  client: RemitClient,
  stores: SqliteStores,
  wipeTenantObject: () => Promise<void>,
): AccountPurgeContext => ({
  client,
  purgeQueue: queueProducer<"Grouped", AccountFinalizeEvent>("Grouped", env, tenantId),
  capabilities: workersDeletion(env.MAIL, tenantId, stores, wipeTenantObject),
});
