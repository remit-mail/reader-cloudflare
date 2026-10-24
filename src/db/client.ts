import type { BatchItem } from "drizzle-orm/batch";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type AppDb = DrizzleD1Database<typeof schema>;

export type Statement = BatchItem<"sqlite">;

export const openAppDb = (binding: D1Database): AppDb => drizzle(binding, { schema });

export const runBatch = async (
  db: AppDb,
  statements: readonly [Statement, ...Statement[]],
): Promise<void> => {
  await db.batch(statements);
};
