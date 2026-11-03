import { deriveAccountConfigId } from "@remit/data-ports/id";
import { wrangler, wranglerOutput } from "./cf.mjs";

const UNMAPPED_TENANTS =
  "SELECT DISTINCT tenant_id FROM tenant_key WHERE tenant_id NOT IN (SELECT tenant_id FROM tenant_account_config)";

const literal = (value) => `'${value.replaceAll("'", "''")}'`;

const execute = (config, database, sql) => [
  "d1",
  "execute",
  database,
  "--remote",
  "--config",
  config,
  "--command",
  sql,
];

export const backfillTenantAccountConfigs = (config, database) => {
  const [result] = JSON.parse(
    wranglerOutput([...execute(config, database, UNMAPPED_TENANTS), "--json"]),
  );
  const tenants = result.results.map((row) => row.tenant_id);
  console.log(`backfill: ${tenants.length} tenant(s) without a tenant_account_config row`);
  if (tenants.length === 0) return 0;
  const rows = tenants
    .map((tenantId) => `(${literal(deriveAccountConfigId(tenantId))}, ${literal(tenantId)})`)
    .join(", ");
  return wrangler(
    execute(
      config,
      database,
      `INSERT OR IGNORE INTO tenant_account_config (account_config_id, tenant_id) VALUES ${rows}`,
    ),
  );
};
