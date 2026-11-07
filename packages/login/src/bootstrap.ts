import { audit } from "./audit";
import type { LoginConfig } from "./config";
import { log } from "./log";
import { sendInvite } from "./mail";
import { issueInvite, revokeInvite } from "./routes/app";

export const bootstrapOperators = async (
  db: D1Database,
  email: SendEmail,
  config: LoginConfig,
  now: number,
): Promise<number> => {
  const operators = [...config.operatorEmails];
  if (operators.length === 0) return 0;
  const placeholders = operators.map(() => "?").join(",");
  const existing = await db
    .prepare(`SELECT COUNT(*) AS count FROM user WHERE lower(email) IN (${placeholders})`)
    .bind(...operators)
    .first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return 0;
  const open = await db
    .prepare(
      `SELECT DISTINCT email FROM invite WHERE state = 'Open' AND expires_at > ? AND email IN (${placeholders})`,
    )
    .bind(now, ...operators)
    .all<{ email: string }>();
  const covered = new Set(open.results.map((row) => row.email));
  let issued = 0;
  for (const operator of operators.filter((candidate) => !covered.has(candidate))) {
    const { inviteId, token } = await issueInvite(db, operator, "bootstrap");
    const sent = await sendInvite(email, config, operator, token);
    if (!sent.ok) {
      await revokeInvite(db, inviteId);
      log.error("bootstrap invite refused", { reason: sent.reason });
    }
    await audit(db, {
      actor: "bootstrap",
      email: operator,
      address: "",
      event: "InviteIssued",
      outcome: sent.ok ? "Succeeded" : "Refused",
    });
    if (sent.ok) issued += 1;
  }
  return issued;
};
