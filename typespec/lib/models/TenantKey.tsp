import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("A tenant data key wrapped by the master key of `keyVersion` (AES-GCM).")
@table("tenantKey", "app")
@primaryKey("tenant_key")
model TenantKey {
  @pk
  tenantId: string;

  @pk
  keyVersion: int32;

  wrappedKey: bytes;
  iv: bytes;
}
