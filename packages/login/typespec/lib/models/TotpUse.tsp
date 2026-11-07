import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("A TOTP time step a user spent on a security confirm or an admin step-up; each step works once.")
@entity("totpUse", "login")
@index(
  "TotpUse",
  {
    pk: [TotpUse.userId],
    sk: [TotpUse.totpStep],
  }
)
model TotpUse {
  userId: string;
  totpStep: int64;
  usedFor: string;
  usedAt: int64;
}
