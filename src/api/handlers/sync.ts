import type {
  AccountSyncStatusResponse,
  MailboxSyncProgress,
  SyncPhase,
  SyncTriggerResponse,
} from "@remit/api-openapi-types";
import { z } from "zod";
import { toMailAccount } from "../../db/accounts";
import { currentCorrelationId } from "../../log";
import type { MailboxRow } from "../../mail/types";
import { accountSync, tenantMail } from "../../stubs";
import type { SyncState } from "../../sync/state";
import { accountOf, type Handler, parse } from "../request";
import { notFound, ok, optional } from "../respond";

const accountParams = z.object({ accountId: z.string().min(1) });

const phaseOf = (state: SyncState): SyncPhase => {
  if (state.status === "Failed") return "error";
  if (state.status === "Idle") return state.finishedAt > 0 ? "complete" : "idle";
  if (state.mailboxesTotal === 0) return "discovering_mailboxes";
  return state.currentMailbox.toUpperCase() === "INBOX" ? "syncing_inbox" : "syncing_others";
};

const mailboxPhase = (state: SyncState, mailbox: MailboxRow): string => {
  if (state.status === "Running" && state.currentMailbox === mailbox.fullPath) return "syncing";
  if (mailbox.lastMessageSyncAt === 0 || mailbox.syncStatus === "pending") return "pending";
  return "complete";
};

const toProgress = (state: SyncState, mailbox: MailboxRow): MailboxSyncProgress => ({
  mailboxId: mailbox.mailboxId,
  fullPath: mailbox.fullPath,
  phase: mailboxPhase(state, mailbox),
  messagesTotal: mailbox.messageCount,
  messagesSynced: Math.min(mailbox.storedMessages, mailbox.messageCount),
  highWaterMarkUid: mailbox.highWaterMarkUid,
  ...optional("lastSyncedAt", mailbox.lastMessageSyncAt === 0 ? null : mailbox.lastMessageSyncAt),
});

const triggerSync: Handler = async (context, request) => {
  const params = parse(accountParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const { tenantId } = request.tenant;
  const account = await accountOf(request, params.value.accountId);
  if (account === undefined) return notFound("Account");
  const start = await accountSync(request.env, tenantId, account.accountId).start(
    toMailAccount(tenantId, account),
    currentCorrelationId(),
  );
  const body: SyncTriggerResponse = {
    triggered: start.started,
    message: start.started ? "Sync started" : "Sync already running",
  };
  return ok(body);
};

const getSyncStatus: Handler = async (context, request) => {
  const params = parse(accountParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const { tenantId } = request.tenant;
  const account = await accountOf(request, params.value.accountId);
  if (account === undefined) return notFound("Account");
  const state = await accountSync(request.env, tenantId, account.accountId).status();
  const mailboxes = await tenantMail(request.env, tenantId).listMailboxRows([account.accountId]);
  const running = state.status === "Running";
  const body: AccountSyncStatusResponse = {
    accountId: account.accountId,
    syncPhase: phaseOf(state),
    mailboxCountTotal: running ? state.mailboxesTotal : mailboxes.length,
    mailboxCountSynced: running ? state.mailboxesDone : mailboxes.length,
    ...optional("lastSyncAt", state.finishedAt === 0 ? null : state.finishedAt),
    mailboxes: mailboxes.map((mailbox) => toProgress(state, mailbox)),
  };
  return ok(body);
};

export const syncHandlers = {
  SyncOperations_triggerSync: triggerSync,
  SyncOperations_getSyncStatus: getSyncStatus,
} satisfies Record<string, Handler>;
