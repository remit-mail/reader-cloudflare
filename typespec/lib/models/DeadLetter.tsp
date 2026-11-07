import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace ReaderCloudflare;

@doc("A queue message that exhausted its retries, parked with the envelope it carried.")
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
  family: string;
  type: string;
  correlationId: string;
  attempts: int32;
  body: string;
}
