import { z } from "zod";

export const syncedMessageSchema = z.object({
  messageId: z.string().min(1),
  uid: z.number().int().positive(),
});

export const processBatchSchema = z.object({
  kind: z.literal("ProcessBatch"),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  accountConfigId: z.string().min(1),
  mailboxId: z.string().regex(/^[a-z0-9]+$/),
  messages: z.array(syncedMessageSchema).min(1).max(25),
  correlationId: z.string().default(""),
  redrive: z.boolean().default(false),
  split: z.boolean().default(false),
});

export const syncMessageSchema = z.discriminatedUnion("kind", [processBatchSchema]);

export type ProcessBatch = z.infer<typeof processBatchSchema>;

export type SyncMessage = z.infer<typeof syncMessageSchema>;
