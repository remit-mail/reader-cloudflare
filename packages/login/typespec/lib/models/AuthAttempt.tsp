import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("Failure counter for one account or one network address, driving backoff.")
@entity("authAttempt", "login")
@index(
  "AuthAttempt",
  {
    pk: [AuthAttempt.attemptKey],
    sk: [],
  }
)
model AuthAttempt {
  attemptKey: string;
  failures: int32;
  lastFailureAt: int64;
  nextAllowedAt: int64;
}
