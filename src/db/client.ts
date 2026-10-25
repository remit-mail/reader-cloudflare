import { asyncBatch, type WriteBatch } from "@remit/drizzle-service";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";

export type AppDb = DrizzleD1Database;

export interface AppStore {
  readonly db: AppDb;
  readonly batch: WriteBatch;
}

export const openAppDb = (binding: D1Database): AppDb => drizzle(binding);

export const openAppStore = (binding: D1Database): AppStore => {
  const db = openAppDb(binding);
  return { db, batch: asyncBatch(db) };
};
