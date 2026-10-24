import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("Binds an account to the tenant that owns it. An account belongs to exactly one tenant.")
@table("tenantAccount", "app")
@primaryKey("tenant_account")
model TenantAccount {
  @pk
  tenantId: string;

  @pk
  @unique
  accountId: string;
}
