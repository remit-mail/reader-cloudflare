import type { capturedMails } from "login-db-schema";
import type { Env } from "./env";

export type CapturedMail = typeof capturedMails.$inferSelect;

export const CAPTURE_RETENTION_MS = 60 * 60_000;
const LATEST_LIMIT = 20;

const isComposed = (message: EmailMessage | EmailMessageBuilder): message is EmailMessageBuilder =>
  "subject" in message;

const addressOf = (address: string | EmailAddress): string =>
  typeof address === "string" ? address : address.email;

const recipientsOf = (to: EmailMessageBuilder["to"]): string => {
  if (to === undefined) return "";
  return (Array.isArray(to) ? to : [to]).map(addressOf).join(", ");
};

const captureInto = (db: D1Database): SendEmail => ({
  send: async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
    if (!isComposed(message)) throw new Error("mail capture stores composed messages only");
    const capturedMailId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO captured_mail (captured_mail_id, captured_at, recipient, subject, body) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        capturedMailId,
        Date.now(),
        recipientsOf(message.to),
        message.subject,
        message.text ?? "",
      )
      .run();
    return { messageId: capturedMailId };
  },
});

export const capturesMail = (env: Env): boolean => env.MAIL_CAPTURE === "on";

export const mailerOf = (env: Env): SendEmail => {
  if (capturesMail(env)) return captureInto(env.DB);
  if (env.EMAIL === undefined) {
    throw new Error("the login Worker has no EMAIL binding and does not capture mail");
  }
  return env.EMAIL;
};

export const latestCapturedMail = async (db: D1Database, now: number): Promise<CapturedMail[]> => {
  const rows = await db
    .prepare(
      "SELECT captured_mail_id, captured_at, recipient, subject, body FROM captured_mail WHERE captured_at >= ? ORDER BY captured_at DESC LIMIT ?",
    )
    .bind(now - CAPTURE_RETENTION_MS, LATEST_LIMIT)
    .all<{
      captured_mail_id: string;
      captured_at: number;
      recipient: string;
      subject: string;
      body: string;
    }>();
  return rows.results.map((row) => ({
    capturedMailId: row.captured_mail_id,
    capturedAt: row.captured_at,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
  }));
};
