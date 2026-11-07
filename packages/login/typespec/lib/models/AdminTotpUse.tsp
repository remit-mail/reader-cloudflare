import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("A TOTP time step an operator spent on a step-up; each step works once.")
@entity("adminTotpUse", "login")
@index(
  "AdminTotpUse",
  {
    pk: [AdminTotpUse.operatorUserId],
    sk: [AdminTotpUse.totpStep],
  }
)
model AdminTotpUse {
  operatorUserId: string;
  totpStep: int64;
  adminChallengeId: string;
  usedAt: int64;
}
