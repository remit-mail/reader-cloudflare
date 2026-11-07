import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("A single-use step-up challenge bound to one operator, session, action and target.")
@entity("adminChallenge", "login")
@index(
  "AdminChallenge",
  {
    pk: [AdminChallenge.adminChallengeId],
    sk: [],
  }
)
@Drizzle.indexDef("admin_challenge_operator", [AdminChallenge.operatorUserId])
@Drizzle.indexDef(
  "admin_challenge_one_open",
  [AdminChallenge.operatorUserId],
  true,
  "state = 'Open'"
)
model AdminChallenge {
  adminChallengeId: string;
  operatorUserId: string;
  sessionId: string;
  action: AdminAction;
  targetEmail: string;
  challenge: string;
  method: StepUpMethod;
  state: AdminChallengeState;
  expiresAt: int64;
}
