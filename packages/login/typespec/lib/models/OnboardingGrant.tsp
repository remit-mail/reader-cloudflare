import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("The cookie grant a redeemed invite issues, good for choosing a password once.")
@entity("onboardingGrant", "login")
@index(
  "OnboardingGrant",
  {
    pk: [OnboardingGrant.onboardingGrantId],
    sk: [],
  }
)
@Drizzle.indexDef(
  "onboarding_grant_token_hash",
  [OnboardingGrant.tokenHash],
  true
)
model OnboardingGrant {
  onboardingGrantId: string;
  inviteId: string;
  email: string;
  tokenHash: string;
  expiresAt: int64;
}
