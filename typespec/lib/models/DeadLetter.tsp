import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("A queue message that exhausted its retries, parked with the ids its event carried.")
@entity("deadLetter", "app")
@index(
  "DeadLetter",
  {
    pk: [DeadLetter.deadLetterId],
    sk: [],
  }
)
model DeadLetter {
  deadLetterId: string;
  tenantId: string;
  type: string;
  attempts: int32;
  body: string;
}
