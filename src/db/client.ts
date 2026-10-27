import { asyncBatch, type SqliteLimits, type SqliteStore } from "@remit/drizzle-service";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";

export type AppDb = DrizzleD1Database;

export type AppStore = SqliteStore<Record<string, unknown>>;

export const openAppDb = (binding: D1Database): AppDb => drizzle(binding);

export const openAppStore = (
  binding: D1Database,
  { maxBoundParameters }: SqliteLimits,
): AppStore => {
  const db = openAppDb(binding);
  return { db, batch: asyncBatch(db), maxBoundParameters };
};
