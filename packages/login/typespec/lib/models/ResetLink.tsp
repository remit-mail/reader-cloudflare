import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("An emailed password reset link, good once for 1 hour. Only the SHA-256 of its token is stored.")
@entity("resetLink", "login")
@index(
  "ResetLink",
  {
    pk: [ResetLink.resetLinkId],
    sk: [],
  }
)
@Drizzle.indexDef("reset_link_token_hash", [ResetLink.tokenHash], true)
@Drizzle.indexDef("reset_link_user", [ResetLink.userId])
model ResetLink {
  resetLinkId: string;
  userId: string;
  email: string;
  tokenHash: string;
  state: ResetLinkState;
  createdAt: int64;
  expiresAt: int64;
  stateChangedAt: int64;
}
