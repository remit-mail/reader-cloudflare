import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("A login message the dev stage stored instead of sending, kept one hour. Prod never writes one.")
@entity("capturedMail", "login")
@index(
  "CapturedMail",
  {
    pk: [CapturedMail.capturedMailId],
    sk: [],
  }
)
@Drizzle.indexDef("captured_mail_captured_at", [CapturedMail.capturedAt])
model CapturedMail {
  capturedMailId: string;
  capturedAt: int64;
  recipient: string;
  subject: string;
  body: string;
}
