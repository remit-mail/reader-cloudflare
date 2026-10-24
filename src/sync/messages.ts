import { z } from "zod";

export const processBatchSchema = z.object({
  kind: z.literal("ProcessBatch"),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  accountConfigId: z.string().min(1),
  mailboxId: z.string().regex(/^[a-z0-9]+$/),
  uidValidity: z.number().int().nonnegative(),
  keys: z.array(z.string().min(1)).min(1).max(25),
});

export const syncMessageSchema = z.discriminatedUnion("kind", [processBatchSchema]);

export type ProcessBatch = z.infer<typeof processBatchSchema>;

export type SyncMessage = z.infer<typeof syncMessageSchema>;

export const objectMetadataSchema = z.object({
  uid: z.coerce.number().int().positive(),
  sequenceNumber: z.coerce.number().int().nonnegative(),
  uidValidity: z.coerce.number().int().nonnegative(),
  internalDate: z.coerce.number().int(),
  rfc822Size: z.coerce.number().int().nonnegative(),
  flags: z
    .string()
    .transform((value): unknown => JSON.parse(value))
    .pipe(z.array(z.string())),
});

export type ObjectMetadata = z.infer<typeof objectMetadataSchema>;

export const toCustomMetadata = (metadata: ObjectMetadata): Record<string, string> => ({
  uid: String(metadata.uid),
  sequenceNumber: String(metadata.sequenceNumber),
  uidValidity: String(metadata.uidValidity),
  internalDate: String(metadata.internalDate),
  rfc822Size: String(metadata.rfc822Size),
  flags: JSON.stringify(metadata.flags),
});

export const messageKey = (
  tenantId: string,
  accountId: string,
  mailboxId: string,
  uid: number,
): string => `tenant/${tenantId}/account/${accountId}/mailbox/${mailboxId}/uid/${uid}.eml`;
