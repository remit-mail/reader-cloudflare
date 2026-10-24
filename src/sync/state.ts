import { z } from "zod";

export const syncStateSchema = z.object({
  status: z.enum(["Idle", "Running", "Failed"]),
  correlationId: z.string(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  passes: z.number().int().nonnegative(),
  resumeAt: z.number().int().nonnegative(),
  mailboxesDone: z.number().int().nonnegative(),
  mailboxesTotal: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  dumped: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  currentMailbox: z.string(),
  error: z.string(),
});

export type SyncState = z.infer<typeof syncStateSchema>;

export const mailboxMarkSchema = z.object({
  uidValidity: z.number().int().nonnegative(),
  lowWaterMark: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative(),
});

export type MailboxMark = z.infer<typeof mailboxMarkSchema>;

export const mailboxMarksSchema = z.record(z.string(), mailboxMarkSchema);

export type MailboxMarks = z.infer<typeof mailboxMarksSchema>;

export interface SyncStart {
  readonly started: boolean;
  readonly state: SyncState;
}

export const NEVER_SYNCED: SyncState = {
  status: "Idle",
  correlationId: "",
  startedAt: 0,
  updatedAt: 0,
  finishedAt: 0,
  passes: 0,
  resumeAt: 0,
  mailboxesDone: 0,
  mailboxesTotal: 0,
  remaining: 0,
  dumped: 0,
  batches: 0,
  currentMailbox: "",
  error: "",
};
