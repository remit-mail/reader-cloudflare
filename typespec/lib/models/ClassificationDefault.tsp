import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("The deployment default of the mail classifier, one fixed row; `apiKeySealed` is the API key sealed under the master key of `keyVersion` (AES-GCM).")
@entity("classificationDefault", "app")
@index(
  "ClassificationDefault",
  {
    pk: [ClassificationDefault.classificationDefaultId],
    sk: [],
  }
)
model ClassificationDefault {
  classificationDefaultId: string;
  presetId: string;
  `model`: string;
  baseUrl: string;
  apiKeySealed: bytes;
  iv: bytes;
  keyVersion: int32;
  dailyLimit: int32;
  enabled: boolean;
  version: int32;
  updatedAt: int64;
  updatedBy: string;
}
