import { DurableObject } from "cloudflare:workers";
import { processAccountFanoutEvent } from "@remit/account-worker/process";
import type { RemitClient } from "@remit/backend/client";
import {
  composeReadPathServices,
  composeSyncServices,
  createRemitCore,
} from "@remit/backend/create-remit-client";
import type { UserIdentity } from "@remit/backend/serve";
import type { AddressItem, CreateAddressInput, MailboxItem, ResultList } from "@remit/data-ports";
import { deriveAddressId, deriveBodyPartId, deriveEnvelopeId } from "@remit/data-ports/id";
import {
  asyncBatch,
  composeSqliteRepositories,
  type SqliteRepositories,
  syncStore,
} from "@remit/drizzle-service";
import { type ConnectionPool, type ProcessContext, processEvent } from "@remit/imap-worker/process";
import { logger } from "@remit/logger";
import {
  BodySyncService,
  QuarantineService,
  resolveFolderPlacement,
  SyncWarningService,
} from "@remit/mailbox-service";
import { drizzle } from "drizzle-orm/durable-sqlite";
import migrations from "../../migrations/mail/migrations";
import { type ServedQueues, serveTenantApi } from "../api/serve";
import { r2Storage } from "../api/storage";
import { commit } from "../commit";
import { tenantSecrets } from "../crypto/envelope";
import { openAppDb } from "../db/client";
import { migrateDurableObject } from "../db/durable-migrate";
import type { Env } from "../env";
import { errorKindOf, messageOf } from "../error-kind";
import { type ConsumeReport, log, withLogContext } from "../log";
import { queueProducer } from "../queue/producer";
import type { ConsumedFamily, EventOn, QueueEnvelope, ReaderEvent } from "../queue/routing";
import { connectImap, workersConnectionScope } from "./imap-connect";
import { describeMessage, starOf } from "./operations";
import { metered, meteredPool } from "./pool";
import { processContext } from "./process-context";
import { storedBodies } from "./stored-bodies";
import type {
  AddressInput,
  AddressPageRequest,
  AddressRole,
  BodyBatch,
  BodyBatchResult,
  MailAccount,
  MailboxInput,
  MailResult,
  MessageInput,
  MessageRecord,
  SyncedMessage,
} from "./types";

const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";
const NO_PARENT = "";

type Sighting = "junk" | "discarded" | "correspondent";

const parentPath = (path: string, delimiter: string): string | null => {
  if (delimiter === "") return null;
  const index = path.lastIndexOf(delimiter);
  if (index <= 0) return null;
  return path.slice(0, index);
};

const splitAddress = (address: string): { localPart: string; domain: string } | null => {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
};

const roles = (input: MessageInput): readonly [AddressRole, readonly AddressInput[]][] => [
  ["from", input.envelope.from],
  ["sender", input.envelope.sender],
  ["reply_to", input.envelope.replyTo],
  ["to", input.envelope.to],
  ["cc", input.envelope.cc],
  ["bcc", input.envelope.bcc],
];

class UnservedEventError extends Error {
  readonly family: ConsumedFamily;
  readonly type: ReaderEvent["type"];

  constructor(family: ConsumedFamily, type: ReaderEvent["type"]) {
    super(`the ${family} queue has no consumer for ${type} in this Worker yet`);
    this.name = "UnservedEventError";
    this.family = family;
    this.type = type;
  }
}

interface Composed {
  readonly tenantId: string;
  readonly client: RemitClient<ServedQueues>;
  readonly process: ProcessContext;
}

const consumeFanout = (event: ReaderEvent, client: RemitClient<ServedQueues>): Promise<void> => {
  switch (event.type) {
    case "OrganizeJob":
    case "SenderCategoryBackApply":
      return processAccountFanoutEvent(event, { client });
    default:
      throw new UnservedEventError("fanout", event.type);
  }
};

const consumeMutation = (
  event: ReaderEvent,
  context: ProcessContext,
  attempts: number,
): Promise<void> => {
  switch (event.type) {
    case "FLAG_PUSH":
    case "PLACEMENT_MOVE_PUSH":
    case "MAILBOX_CREATE":
    case "MAILBOX_RENAME":
    case "MAILBOX_DELETE":
    case "MESSAGE_MOVE":
    case "MESSAGE_DELETE":
    case "MESSAGE_COPY":
    case "EMPTY_TRASH":
    case "APPEND_SENT_MESSAGE":
    case "DELETE_ACCOUNT_OBJECTS":
      return processEvent(event, context, attempts);
    default:
      throw new UnservedEventError("mutation", event.type);
  }
};

const sightingIn = (mailbox: MailboxItem): Sighting => {
  const uses = mailbox.specialUse ?? [];
  if (uses.includes("Junk")) return "junk";
  if (uses.includes("Trash")) return "discarded";
  return "correspondent";
};

export class TenantMail extends DurableObject<Env> {
  private readonly mail: SqliteRepositories;
  private readonly pool: ConnectionPool;
  private composed: Composed | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    const mail = syncStore(db);
    const appDb = openAppDb(env.DB);
    this.mail = composeSqliteRepositories({
      app: { db: appDb, batch: asyncBatch(appDb) },
      mail,
      search: mail,
    });
    this.pool = meteredPool({ size: 1, overflow: "Wait" }, connectImap);
    void ctx.blockConcurrencyWhile(() => migrateDurableObject(db, migrations));
  }

  async api(request: Request, identity: UserIdentity, correlationId: string): Promise<Response> {
    return withLogContext({ correlationId, tenantId: identity.sub }, () =>
      serveTenantApi(request, identity, this.compose(identity.sub).client, correlationId),
    );
  }

  async consume(
    family: ConsumedFamily,
    envelope: QueueEnvelope,
    attempts: number,
  ): Promise<ConsumeReport> {
    const { tenantId, correlationId, event } = envelope;
    const meter = { waitedMs: 0 };
    return withLogContext({ correlationId, tenantId, family, attempt: attempts }, () =>
      metered(meter, () => this.dispatch(family, event, tenantId, attempts)).then(
        (): ConsumeReport => ({ outcome: "Acked", poolWaitMs: meter.waitedMs }),
        (error: unknown): ConsumeReport => ({
          outcome: "Retried",
          poolWaitMs: meter.waitedMs,
          errorKind: errorKindOf(error),
          error: messageOf(error),
        }),
      ),
    );
  }

  private async dispatch(
    family: ConsumedFamily,
    event: ReaderEvent,
    tenantId: string,
    attempts: number,
  ): Promise<void> {
    const composed = this.compose(tenantId);
    switch (family) {
      case "fanout":
        return consumeFanout(event, composed.client);
      case "mutation":
        return consumeMutation(event, composed.process, attempts);
      case "smtp":
        throw new UnservedEventError(family, event.type);
    }
  }

  async upsertMailboxes(
    account: MailAccount,
    input: readonly MailboxInput[],
  ): Promise<readonly { readonly mailboxId: string; readonly path: string }[]> {
    const { mailbox } = this.mail;
    const stored: { mailboxId: string; path: string }[] = [];
    for (const entry of input) {
      const parent = parentPath(entry.path, entry.delimiter);
      const parentRow =
        parent === null ? null : await mailbox.findByPath(account.accountId, parent);
      const counters = {
        hierarchyDelimiter: entry.delimiter,
        namespacePrefix: entry.namespacePrefix,
        uidValidity: entry.uidValidity,
        uidNext: entry.uidNext,
        highestModseq: entry.highestModseq,
        messageCount: entry.messageCount,
        unseenCount: entry.unseenCount,
        parentMailboxId: parentRow?.mailboxId ?? NO_PARENT,
        specialUse: [...entry.specialUse],
      };
      const existing = await mailbox.findByPath(account.accountId, entry.path);
      const row =
        existing === null
          ? await mailbox.getOrCreateByPath(account.accountId, entry.path, {
              ...counters,
              deletedCount: 0,
              totalSize: 0,
              lastSyncUid: 0,
              highWaterMarkUid: 0,
              lastMessageSyncAt: 0,
            })
          : await mailbox.update(account.accountId, existing.mailboxId, counters);
      stored.push({ mailboxId: row.mailboxId, path: entry.path });
    }
    log.info("mailboxes upserted", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      count: stored.length,
    });
    return stored;
  }

  async upsertMessages(
    account: MailAccount,
    mailboxId: string,
    input: readonly MessageInput[],
  ): Promise<MailResult<readonly SyncedMessage[]>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) {
      log.warn("mailbox not found", {
        tenantId: account.tenantId,
        accountId: account.accountId,
        mailboxId,
      });
      return { ok: false, reason: "mailbox not found" };
    }
    const stored: SyncedMessage[] = [];
    for (const message of input) {
      await this.saveMessage(account, mailbox, message);
      stored.push({ messageId: message.messageId, uid: message.uid });
    }
    log.info("messages upserted", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      count: stored.length,
    });
    return { ok: true, value: stored };
  }

  async recordMailboxPass(
    account: MailAccount,
    mailboxId: string,
    lastSyncUid: number,
  ): Promise<MailResult<number>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return { ok: false, reason: "mailbox not found" };
    await this.mail.mailbox.update(account.accountId, mailboxId, {
      lastSyncUid,
      highWaterMarkUid: lastSyncUid,
      lastMessageSyncAt: Date.now(),
    });
    return { ok: true, value: lastSyncUid };
  }

  async lowestStoredUid(account: MailAccount, mailboxId: string): Promise<number> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return 0;
    const page = await this.mail.message.listByMailbox(mailboxId, { limit: 1 });
    return page.items[0]?.uid ?? 0;
  }

  async syncBodies(batch: BodyBatch): Promise<MailResult<BodyBatchResult>> {
    const { account, mailboxId } = batch;
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return { ok: false, reason: "mailbox not found" };
    const bodies = storedBodies(this.env.MAIL, account, mailbox, batch.messages);
    const placement = await resolveFolderPlacement(
      this.mail.mailboxSpecialUse,
      account.accountId,
      mailboxId,
    );
    const result = await this.bodySync(mailbox, batch.attempts).syncBodies(
      batch.messages.map((message) => message.messageId),
      account.accountId,
      account.accountConfigId,
      { mailboxId, fullPath: mailbox.fullPath, placement, uidValidity: mailbox.uidValidity },
      async () => bodies.connection,
    );
    return {
      ok: true,
      value: {
        synced: result.syncedCount,
        skipped: result.skippedCount,
        failed: result.failedCount,
        bytes: bodies.bytesRead(),
      },
    };
  }

  async resetMailbox(account: MailAccount, mailboxId: string): Promise<MailResult<number>> {
    const [mailbox] = await this.mail.mailbox.get(account.accountId, [mailboxId]);
    if (mailbox === undefined) return { ok: false, reason: "mailbox not found" };
    const messages = await this.mail.message.listAllByMailbox(mailboxId);
    const messageIds = messages.map((message) => message.messageId);
    const threads = (
      await Promise.all(
        messageIds.map((messageId) =>
          this.mail.threadMessage.findAllByMessageId(account.accountConfigId, messageId),
        ),
      )
    ).flat();
    await this.mail.threadMessage.deleteMany(
      threads.map((thread) => ({
        accountConfigId: thread.accountConfigId,
        threadMessageId: thread.threadMessageId,
      })),
    );
    await this.mail.message.deleteMany(messageIds);
    await this.mail.mailbox.update(account.accountId, mailboxId, {
      lastSyncUid: 0,
      highWaterMarkUid: 0,
    });
    log.info("mailbox reset", {
      tenantId: account.tenantId,
      accountId: account.accountId,
      mailboxId,
      removed: messageIds.length,
    });
    return { ok: true, value: messageIds.length };
  }

  async listMailboxItems(accountIds: readonly string[]): Promise<readonly MailboxItem[]> {
    const lists = await Promise.all(
      accountIds.map((accountId) => this.mail.mailbox.listAllByAccount(accountId)),
    );
    return lists.flat();
  }

  async describeMessage(accountConfigId: string, messageId: string): Promise<MessageRecord | null> {
    return describeMessage(this.mail, accountConfigId, messageId);
  }

  private bodySync(mailbox: MailboxItem, attempts: number): BodySyncService {
    return new BodySyncService(
      this.mail.message,
      r2Storage(this.env.MAIL),
      this.mail.threadMessage,
      this.mail.address,
      this.mail.envelope,
      new SyncWarningService(this.mail.syncWarning),
      logger,
      undefined,
      undefined,
      {
        quarantineService: new QuarantineService(
          this.mail.quarantine,
          this.mail.mailboxSpecialUse,
          commit,
          logger,
        ),
        mailboxId: mailbox.mailboxId,
        uidValidity: mailbox.uidValidity,
        attempts,
      },
    );
  }

  private compose(tenantId: string): Composed {
    if (this.composed !== null) {
      if (this.composed.tenantId !== tenantId) {
        throw new Error(`mail object of ${this.composed.tenantId} refused tenant ${tenantId}`);
      }
      return this.composed;
    }
    const client = this.clientOf(tenantId);
    this.composed = {
      tenantId,
      client,
      process: processContext(this.env, tenantId, client, this.pool),
    };
    return this.composed;
  }

  private clientOf(tenantId: string): RemitClient<ServedQueues> {
    const core = createRemitCore({
      repositories: this.mail,
      storage: r2Storage(this.env.MAIL),
      secrets: tenantSecrets(this.env, tenantId),
      connectionScope: workersConnectionScope,
    });
    const queues = {
      sync: queueProducer<"Fifo", EventOn<"sync">>("Fifo", this.env, tenantId),
      accountFanout: queueProducer<"Standard", EventOn<"accountFanout">>(
        "Standard",
        this.env,
        tenantId,
      ),
      messageManagement: queueProducer<"Standard", EventOn<"messageManagement">>(
        "Standard",
        this.env,
        tenantId,
      ),
    };
    const sync = composeSyncServices(core, queues);
    return { ...core, queues, ...sync, ...composeReadPathServices(core, queues, sync) };
  }

  async listAddresses(accountConfigId: string): Promise<AddressItem[]> {
    return this.mail.address.listAllByAccountConfig(accountConfigId);
  }

  async listAddressPage(page: AddressPageRequest): Promise<ResultList<AddressItem>> {
    return this.mail.address.listAllByAccountConfigPage(page);
  }

  async upsertAddress(input: CreateAddressInput): Promise<AddressItem> {
    return this.mail.address.upsertAddress(input);
  }

  private async saveMessage(
    account: MailAccount,
    mailbox: MailboxItem,
    input: MessageInput,
  ): Promise<void> {
    const { envelope, messageId } = input;
    const envelopeId = deriveEnvelopeId(messageId);
    await this.mail.envelope.upsertEnvelope({
      envelopeId,
      messageId,
      dateValue: envelope.date,
      dateRaw: envelope.dateRaw,
      ...(envelope.subject === null ? {} : { subject: envelope.subject }),
      ...(envelope.messageId === null ? {} : { messageIdValue: envelope.messageId }),
    });
    const from = await this.saveAddresses(account, mailbox, messageId, input);
    await this.mail.message.upsertWithStatus({
      messageId,
      mailboxId: mailbox.mailboxId,
      uid: input.uid,
      sequenceNumber: input.sequenceNumber,
      rfc822Size: input.rfc822Size,
      internalDate: input.internalDate,
      envelopeId,
      rootBodyPartId: deriveBodyPartId(messageId, "0"),
    });
    await this.saveFlags(messageId, input.flags);
    await this.saveThread(account, mailbox, messageId, input, from);
  }

  private async saveFlags(messageId: string, flags: readonly string[]): Promise<void> {
    const wanted = new Set(flags);
    const stored = new Set(
      (await this.mail.messageFlag.getFlags(messageId)).map((flag) => flag.flagName),
    );
    await this.mail.messageFlag.removeFlags(
      messageId,
      [...stored].filter((flag) => !wanted.has(flag)),
    );
    await this.mail.messageFlag.addFlags(
      messageId,
      [...wanted].filter((flag) => !stored.has(flag)),
    );
  }

  private async saveAddresses(
    account: MailAccount,
    mailbox: MailboxItem,
    messageId: string,
    input: MessageInput,
  ): Promise<{ email: string; name: string } | null> {
    const sighting = sightingIn(mailbox);
    let from: { email: string; name: string } | null = null;
    for (const [role, list] of roles(input)) {
      for (const [order, entry] of list.entries()) {
        const parts = splitAddress(entry.address);
        if (parts === null) continue;
        const normalizedEmail = entry.address.toLowerCase();
        const displayName = entry.name ?? "";
        const address: CreateAddressInput = {
          addressId: deriveAddressId(account.accountConfigId, normalizedEmail),
          accountConfigId: account.accountConfigId,
          localPart: parts.localPart,
          domain: parts.domain,
          normalizedEmail,
          normalizedCompound: `${displayName.toLowerCase()} ${normalizedEmail}`.trim(),
          displayName,
        };
        if (sighting === "junk") await this.mail.address.upsertJunkAddress(address);
        if (sighting === "discarded") await this.mail.address.upsertAddress(address);
        if (sighting === "correspondent") {
          await this.mail.address.upsertCorrespondentAddress(address);
        }
        await this.mail.address.upsertEnvelopeAddress({
          messageId,
          addressId: address.addressId,
          displayName,
          normalizedEmail,
          addressRole: role,
          addressOrder: order,
        });
        if (role === "from" && from === null) from = { email: normalizedEmail, name: displayName };
      }
    }
    return from;
  }

  private async saveThread(
    account: MailAccount,
    mailbox: MailboxItem,
    messageId: string,
    input: MessageInput,
    from: { email: string; name: string } | null,
  ): Promise<void> {
    const { envelope } = input;
    const flags = new Set(input.flags);
    const starred = flags.has(FLAGGED);
    const summary = {
      mailboxId: mailbox.mailboxId,
      uid: input.uid,
      internalDate: input.internalDate,
      sentDate: envelope.date,
      isRead: flags.has(SEEN),
      hasAttachment: input.hasAttachment,
      hasStars: starred,
      star: starOf(starred),
      ...(envelope.subject === null ? {} : { subject: envelope.subject }),
      ...(envelope.messageId === null ? {} : { messageIdHeader: envelope.messageId }),
      ...(envelope.inReplyTo === null ? {} : { inReplyTo: envelope.inReplyTo }),
      ...(from === null ? {} : { fromEmail: from.email }),
      ...(from === null || from.name === "" ? {} : { fromName: from.name }),
    };
    const existing = await this.mail.threadMessage.findByMessageId(
      account.accountConfigId,
      messageId,
    );
    if (existing !== null) {
      await this.mail.threadMessage.update(
        account.accountConfigId,
        existing.threadMessageId,
        summary,
      );
      return;
    }
    await this.mail.threadMessage.create({
      ...summary,
      threadId: messageId,
      messageId,
      accountConfigId: account.accountConfigId,
      referenceOrder: 0,
      isDeleted: false,
    });
  }
}
