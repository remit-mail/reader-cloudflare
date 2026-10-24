import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("Binds an account to the tenant that owns it. An account belongs to exactly one tenant.")
@entity("tenantAccount", "app")
@index(
  "TenantAccount",
  {
    pk: [TenantAccount.tenantId],
    sk: [TenantAccount.accountId],
  }
)
@indexDef("tenant_account_account_id_unique", [TenantAccount.accountId], true)
model TenantAccount {
  tenantId: string;
  accountId: string;
}
