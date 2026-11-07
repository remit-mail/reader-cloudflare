import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("Attempts counted for one account, user or network address, driving backoff. Each attempt is reserved before its proof is checked.")
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
  attempts: int32;
  lastAttemptAt: int64;
  nextAllowedAt: int64;
  lastAttemptId: string;
}
