import "typespec-electrodb-emitter";
import "@kattebak/typespec-drizzle-orm-generator";

using Drizzle;

namespace Login;

@doc("One sign-in or operator event, kept 90 days. Holds no password, token or code.")
@entity("auditEvent", "login")
@index(
  "AuditEvent",
  {
    pk: [AuditEvent.auditEventId],
    sk: [],
  }
)
@Drizzle.indexDef("audit_event_at", [AuditEvent.at])
model AuditEvent {
  auditEventId: string;
  at: int64;
  actor: string;
  email: string;
  address: string;
  event: AuditEventKind;
  outcome: AuditOutcome;
  clientId: string;
}
