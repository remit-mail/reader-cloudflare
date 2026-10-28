import { eq } from "drizzle-orm";
import { getTableConfig, type SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppStore } from "./client";
import * as appTables from "./schema";

const TENANT_COLUMN = "tenant_id";

interface TenantTable {
  readonly table: SQLiteTable;
  readonly tenantColumn: SQLiteColumn;
}

const TENANT_TABLES: readonly TenantTable[] = Object.values(appTables).flatMap((table) => {
  if (!(table instanceof SQLiteTable)) return [];
  const tenantColumn = getTableConfig(table).columns.find(
    (column) => column.name === TENANT_COLUMN,
  );
  return tenantColumn === undefined ? [] : [{ table, tenantColumn }];
});

export const eraseTenantRows = async (app: AppStore, tenantId: string): Promise<void> => {
  await app.batch(
    TENANT_TABLES.map(({ table, tenantColumn }) =>
      app.db.delete(table).where(eq(tenantColumn, tenantId)),
    ),
  );
};
