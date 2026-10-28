import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("The tenant whose Access subject derives `accountConfigId`, for routes no Access identity reaches.")
@entity("tenantAccountConfig", "app")
@index(
  "TenantAccountConfig",
  {
    pk: [TenantAccountConfig.accountConfigId],
    sk: [],
  }
)
model TenantAccountConfig {
  accountConfigId: string;
  tenantId: string;
}
