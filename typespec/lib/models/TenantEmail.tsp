import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("The lowercased email of the person behind an Access subject, written from the verified Access JWT; the login Worker knows a person only by email.")
@entity("tenantEmail", "app")
@index(
  "TenantEmail",
  {
    pk: [TenantEmail.tenantId],
    sk: [],
  }
)
@indexDef("tenant_email_email", [TenantEmail.email], true)
model TenantEmail {
  tenantId: string;
  email: string;
}
