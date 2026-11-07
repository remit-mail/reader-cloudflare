import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const wranglerLogPath = (): string => {
  const path = process.env.E2E_WRANGLER_LOG;
  if (path === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  return path;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const devTenantId = (identity: string): string =>
  `dev-${createHash("sha256").update(identity.toLowerCase()).digest("hex").slice(0, 32)}`;

const storesUnder = (plugin: string, objectClass: (name: string) => boolean): string[] => {
  const root = join(dirname(wranglerLogPath()), "v3", plugin);
  return readdirSync(root)
    .filter(objectClass)
    .flatMap((dir) =>
      readdirSync(join(root, dir))
        .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
        .map((name) => join(root, dir, name)),
    );
};

export const rowsIn = (
  path: string,
  query: string,
  ...params: SQLInputValue[]
): Record<string, unknown>[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(query)
      .all(...params)
      .filter(isRecord);
  } finally {
    db.close();
  }
};

export const d1Store = (): string => {
  const [store] = storesUnder("d1", (name) => name === "miniflare-D1DatabaseObject");
  if (store === undefined) throw new Error("no local D1 store");
  return store;
};

export const r2Store = (): string => {
  const [store] = storesUnder("r2", (name) => name === "miniflare-R2BucketObject");
  if (store === undefined) throw new Error("no local R2 store");
  return store;
};

// Each tenant has its own mail Durable Object, so the store is the one holding the account.
export const mailStoreOf = (accountId: string): string => {
  const store = storesUnder("do", (name) => name.includes("TenantMail")).find(
    (path) =>
      rowsIn(path, "select 1 from sqlite_master where name = 'mailbox'").length > 0 &&
      rowsIn(path, "select 1 from mailbox where account_id = ?", accountId).length > 0,
  );
  if (store === undefined) throw new Error(`no local mail store holds account ${accountId}`);
  return store;
};

export const deadLettersOf = (identity: string): Record<string, unknown>[] =>
  rowsIn(
    d1Store(),
    "select type, attempts, body from dead_letter where tenant_id = ?",
    devTenantId(identity),
  );

export interface QueueConsume {
  readonly family: string;
  readonly type: string;
  readonly outcome: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

const toConsume = (record: Record<string, unknown>): QueueConsume | undefined => {
  const { family, type, outcome, durationMs, time } = record;
  if (
    typeof family !== "string" ||
    typeof type !== "string" ||
    typeof outcome !== "string" ||
    typeof durationMs !== "number" ||
    typeof time !== "string"
  ) {
    return undefined;
  }
  const endedAt = Date.parse(time);
  return { family, type, outcome, startedAt: endedAt - durationMs, endedAt };
};

export const queueConsumesOf = (identity: string, since: number): QueueConsume[] => {
  const tenantId = devTenantId(identity);
  return readFileSync(wranglerLogPath(), "utf8")
    .split("\n")
    .filter((line) => line.includes('"queue.consume"') && line.includes(tenantId))
    .map((line): unknown => JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1)))
    .filter(isRecord)
    .filter((record) => record.tenantId === tenantId)
    .map(toConsume)
    .filter((consume): consume is QueueConsume => consume !== undefined)
    .filter((consume) => consume.startedAt >= since);
};
