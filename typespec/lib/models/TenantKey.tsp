import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("A tenant data key wrapped by the master key of `keyVersion` (AES-GCM).")
@entity("tenantKey", "app")
@index(
  "TenantKey",
  {
    pk: [TenantKey.tenantId],
    sk: [TenantKey.keyVersion],
  }
)
model TenantKey {
  tenantId: string;
  keyVersion: int32;
  wrappedKey: bytes;
  iv: bytes;
}
