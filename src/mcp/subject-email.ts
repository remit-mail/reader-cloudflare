import type { LoginOperatorService } from "../operator-audit-contract";

const UNKNOWN_EMAIL_DOMAIN = "@subject.invalid";

// The MCP user is keyed by the Access subject, while the login Worker knows a
// person by email. The browser leg is the only place both are known, so it
// records the email on the MCP user for every later bearer request.
export const recordSubjectEmail = async (
  db: D1Database,
  subject: string,
  email: string,
): Promise<void> => {
  const now = Date.now();
  await db.batch([
    db
      .prepare("UPDATE mcp_user SET email = id || ?, updated_at = ? WHERE email = ? AND id <> ?")
      .bind(UNKNOWN_EMAIL_DOMAIN, now, email, subject),
    db
      .prepare(
        `INSERT INTO mcp_user (id, name, email, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
         WHERE mcp_user.email <> excluded.email`,
      )
      .bind(subject, subject, email, now, now),
  ]);
};

export const subjectEmail = async (db: D1Database, subject: string): Promise<string | null> => {
  const row = await db
    .prepare("SELECT email FROM mcp_user WHERE id = ?")
    .bind(subject)
    .first<{ email: string }>();
  return row?.email ?? null;
};

export const isSubjectDisabled = async (
  db: D1Database,
  login: Pick<LoginOperatorService, "isDisabled">,
  subject: string,
): Promise<boolean> => {
  const email = await subjectEmail(db, subject);
  return email === null || (await login.isDisabled(email));
};

export const isSubjectOperator = async (
  db: D1Database,
  login: Pick<LoginOperatorService, "isOperator">,
  subject: string,
): Promise<boolean> => {
  const email = await subjectEmail(db, subject);
  return email !== null && (await login.isOperator(email));
};
