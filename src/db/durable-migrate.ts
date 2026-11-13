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

const FOLDER_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/;

const folderMillis = (name: string): number => {
  const match = FOLDER_TIME.exec(name);
  if (match === null) throw new Error(`mail migration ${name} does not start with a timestamp`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second);
};

const lastAppliedAt = (db: DrizzleSqliteDODatabase): number | null => {
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

export const migrateDurableObject = async (
  db: DrizzleSqliteDODatabase,
  config: MigrationConfig,
): Promise<void> => {
  const latest = Math.max(...Object.keys(config.migrations).map(folderMillis));
  const applied = lastAppliedAt(db);
  if (applied !== null && Number(applied) >= latest) return;
  migrate(db, config);
};
