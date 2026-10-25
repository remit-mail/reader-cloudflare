import { and, desc, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

type MigrationConfig = Parameters<typeof migrate>[1];

const MIGRATIONS_TABLE = "__drizzle_migrations";

const sqliteMaster = sqliteTable("sqlite_master", {
  type: text("type").notNull(),
  name: text("name").notNull(),
});

const appliedMigrations = sqliteTable(MIGRATIONS_TABLE, {
  createdAt: integer("created_at"),
});

const lastAppliedAt = <TSchema extends Record<string, unknown>>(
  db: DrizzleSqliteDODatabase<TSchema>,
): number | null => {
  const table = db
    .select({ name: sqliteMaster.name })
    .from(sqliteMaster)
    .where(and(eq(sqliteMaster.type, "table"), eq(sqliteMaster.name, MIGRATIONS_TABLE)))
    .get();
  if (table === undefined) return null;
  const last = db
    .select({ createdAt: appliedMigrations.createdAt })
    .from(appliedMigrations)
    .orderBy(desc(appliedMigrations.createdAt))
    .limit(1)
    .get();
  return last?.createdAt ?? null;
};

export const migrateDurableObject = async <TSchema extends Record<string, unknown>>(
  db: DrizzleSqliteDODatabase<TSchema>,
  config: MigrationConfig,
): Promise<void> => {
  const latest = config.journal.entries.at(-1)?.when;
  const applied = lastAppliedAt(db);
  if (latest !== undefined && applied !== null && Number(applied) >= latest) return;
  await migrate(db, config);
};
