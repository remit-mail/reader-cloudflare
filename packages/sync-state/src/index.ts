import { z } from "zod";

export const syncStatusSchema = z.enum(["Idle", "Running", "Failed"]);

export const syncStateSchema = z.object({
  status: syncStatusSchema,
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  mailboxesDone: z.number().int().nonnegative(),
  mailboxesTotal: z.number().int().nonnegative(),
  dumped: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  currentMailbox: z.string(),
  error: z.string(),
});

export type SyncStatus = z.infer<typeof syncStatusSchema>;

export type SyncState = z.infer<typeof syncStateSchema>;

export const NEVER_SYNCED: SyncState = {
  status: "Idle",
  startedAt: 0,
  finishedAt: 0,
  mailboxesDone: 0,
  mailboxesTotal: 0,
  dumped: 0,
  batches: 0,
  currentMailbox: "",
  error: "",
};
