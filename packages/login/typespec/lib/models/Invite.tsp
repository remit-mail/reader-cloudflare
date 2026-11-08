import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("An invite to one email. Only the SHA-256 of its token is stored.")
@entity("invite", "login")
@index(
  "Invite",
  {
    pk: [Invite.inviteId],
    sk: [],
  }
)
@Drizzle.indexDef("invite_token_hash", [Invite.tokenHash], true)
@Drizzle.indexDef("invite_email", [Invite.email])
model Invite {
  inviteId: string;
  email: string;
  tokenHash: string;
  state: InviteState;
  createdAt: int64;
  expiresAt: int64;
  stateChangedAt: int64;
  issuedBy: string;
}
