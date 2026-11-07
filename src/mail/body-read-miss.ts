import type { RemitClient } from "@remit/backend/client";
import { logger } from "@remit/logger";
import { isMessageBodySyncBroken, materializeBodyParts } from "@remit/mailbox-service";
import type { ParsedContentStorageKey } from "@remit/storage-service";

export type BodyReadMiss = "Ready" | "Pending" | "Broken" | "NotFound";

// A content read found no object. A stored body that went missing is fetched
// again from IMAP: reader's force flag on the re-armed SYNC_MESSAGE_BODY skips
// its already-stored guard. A refetch that exhausts its retries ends in one of
// reader's two terminal outcomes, a deleted row or the broken-body marker, so
// the caller stops answering 202.
export const bodyReadMiss = async (
  client: RemitClient,
  { accountConfigId, accountId, messageId }: ParsedContentStorageKey,
): Promise<BodyReadMiss> => {
  const [message] = await client.message.get([messageId]);
  if (message === undefined) return "NotFound";
  const [mailbox] = await client.mailbox.get(accountId, [message.mailboxId]);
  if (mailbox === undefined) return "NotFound";
  if (await isMessageBodySyncBroken(client.storage, accountConfigId, accountId, messageId)) {
    return "Broken";
  }
  if (!message.bodyStorageKey) return "Pending";
  const { ready } = await materializeBodyParts(client.bodySync, {
    accountConfigId,
    accountId,
    mailboxId: message.mailboxId,
    messageId,
    uid: message.uid,
    bodyStorageKey: message.bodyStorageKey,
    cue: client.bodySyncQueue,
    logger,
  });
  return ready ? "Ready" : "Pending";
};
