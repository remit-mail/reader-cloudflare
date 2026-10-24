import { z } from "zod";

export const syncStateSchema = z.object({
  status: z.enum(["Idle", "Running", "Failed"]),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  mailboxesDone: z.number().int().nonnegative(),
  mailboxesTotal: z.number().int().nonnegative(),
  dumped: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  currentMailbox: z.string(),
  error: z.string(),
});

export type SyncState = z.infer<typeof syncStateSchema>;

export interface SyncStart {
  readonly started: boolean;
  readonly state: SyncState;
}

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
