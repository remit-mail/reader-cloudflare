import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("The account password sealed with the tenant data key of `keyVersion` (AES-GCM).")
@entity("credential", "app")
@index(
  "Credential",
  {
    pk: [Credential.accountId],
    sk: [],
  }
)
@indexDef("credential_by_key_version", [Credential.keyVersion])
model Credential {
  accountId: string;
  keyVersion: int32;
  ciphertext: bytes;
  iv: bytes;
}
