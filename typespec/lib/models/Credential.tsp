import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("The account password sealed with the tenant data key of `keyVersion` (AES-GCM).")
@table("credential", "app")
@primaryKey("credential")
@indexDef("credential_by_key_version", [Credential.keyVersion])
model Credential {
  @pk
  accountId: string;

  keyVersion: int32;
  ciphertext: bytes;
  iv: bytes;
}
