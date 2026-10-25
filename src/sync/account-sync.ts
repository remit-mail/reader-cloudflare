import { DurableObject } from "cloudflare:workers";
import type { UpdateAccountInput } from "@remit/data-ports";
import type { ImapFlow } from "imapflow";
import { accountPassword, tenantSecrets } from "../crypto/envelope";
import { openSettings } from "../db/settings";
import type { Env } from "../env";
import { errorKindOf } from "../error-kind";
import { log, withLogContext } from "../log";
import { type ImapCredential, openImap } from "../mail/imap-connect";
import { accountCredentials } from "../mail/send";
import type { MailAccount } from "../mail/types";
import { tenantMail } from "../stubs";
import { listServerMailboxes, type ServerMailbox, syncMailbox } from "./dump";
import {
  type MailboxMarks,
  mailboxMarksSchema,
  NEVER_SYNCED,
  type SyncStart,
  type SyncState,
  syncStateSchema,
} from "./state";

const STATE_KEY = "state-v2";
const ACCOUNT_KEY = "account";
const MARKS_KEY = "marks";

const PASS_DELAY_MS = 1000;
const PASS_BUDGET_MS = 90_000;
const LOST_AFTER_MS = 10 * 60_000;

const LOST_RUN = "The sync stopped before it finished. Press Sync to continue where it left off.";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMailAccount = (value: unknown): value is MailAccount =>
  typeof value === "object" &&
  value !== null &&
  "tenantId" in value &&
  typeof value.tenantId === "string" &&
  "accountId" in value &&
  typeof value.accountId === "string" &&
  "accountConfigId" in value &&
  typeof value.accountConfigId === "string";

interface PassOutcome {
  readonly complete: boolean;
}

interface Tally {
  readonly mailboxesDone: number;
  readonly remaining: number;
}

export class AccountSync extends DurableObject<Env> {
  private pass: Promise<void> | null = null;
  private progress: SyncState = NEVER_SYNCED;

  async status(): Promise<SyncState> {
    if (this.pass !== null) return this.progress;
    const stored = await this.load();
    if (stored.status !== "Running") return stored;
    if ((await this.ctx.storage.getAlarm()) !== null) return stored;
    if (Date.now() - stored.updatedAt < LOST_AFTER_MS) return stored;
    const lost: SyncState = {
      ...stored,
      status: "Failed",
      finishedAt: Date.now(),
      error: LOST_RUN,
    };
    log.error("sync lost", {
      event: "sync.failed",
      errorKind: "interrupted",
      correlationId: stored.correlationId,
      startedAt: stored.startedAt,
      updatedAt: stored.updatedAt,
      currentMailbox: stored.currentMailbox,
    });
    await this.save(lost);
    const account: unknown = await this.ctx.storage.get(ACCOUNT_KEY);
    if (isMailAccount(account)) {
      await this.publish(account, { syncPhase: "error", lastError: LOST_RUN });
    }
    return lost;
  }

  async start(account: MailAccount, correlationId: string): Promise<SyncStart> {
    const current = await this.status();
    if (current.status === "Running") return { started: false, state: current };
    const now = Date.now();
    const state: SyncState = {
      ...NEVER_SYNCED,
      status: "Running",
      correlationId,
      startedAt: now,
      updatedAt: now,
    };
    await this.ctx.storage.put({ [ACCOUNT_KEY]: account, [STATE_KEY]: state });
    await this.ctx.storage.setAlarm(now);
    await this.publish(account, { syncPhase: "discovering_mailboxes" });
    log.info("sync started", { tenantId: account.tenantId, accountId: account.accountId });
    return { started: true, state };
  }

  override async alarm(): Promise<void> {
    const state = await this.load();
    if (state.status !== "Running") return;
    this.progress = state;
    const account: unknown = await this.ctx.storage.get(ACCOUNT_KEY);
    if (!isMailAccount(account)) {
      log.error("sync failed", {
        event: "sync.failed",
        errorKind: "storage",
        correlationId: state.correlationId,
        reason: "account missing",
      });
      await this.advance({ status: "Failed", finishedAt: Date.now(), error: "account missing" });
      return;
    }
    this.pass = withLogContext({ correlationId: state.correlationId }, () =>
      this.runPass(account),
    ).finally(() => {
      this.pass = null;
    });
    await this.pass;
  }

  private async runPass(account: MailAccount): Promise<void> {
    const fields = { tenantId: account.tenantId, accountId: account.accountId };
    const started = Date.now();
    await this.advance({ passes: this.progress.passes + 1 });
    const outcome = await this.passOver(account).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        reason: reasonOf(error),
        errorKind: errorKindOf(error),
      }),
    );
    if (!outcome.ok) {
      log.error("sync failed", {
        event: "sync.failed",
        ...fields,
        ...this.progressFields(),
        errorKind: outcome.errorKind,
        reason: outcome.reason,
        durationMs: Date.now() - started,
      });
      await this.advance({ status: "Failed", finishedAt: Date.now(), error: outcome.reason });
      await openSettings(this.env, account.tenantId).account.update(account.accountId, {
        syncPhase: "error",
        lastError: outcome.reason,
      });
      return;
    }
    if (!outcome.value.complete) {
      await this.advance({ currentMailbox: "" });
      await this.ctx.storage.setAlarm(Date.now() + PASS_DELAY_MS);
      log.info("pass scheduled", {
        event: "sync.pass",
        ...fields,
        pass: this.progress.passes,
        mailboxesDone: this.progress.mailboxesDone,
        mailboxesTotal: this.progress.mailboxesTotal,
        remaining: this.progress.remaining,
        dumped: this.progress.dumped,
        resumeAt: this.progress.resumeAt,
        durationMs: Date.now() - started,
        delayMs: PASS_DELAY_MS,
      });
      return;
    }
    await this.advance({ status: "Idle", finishedAt: Date.now(), currentMailbox: "" });
    const finishedAt = Date.now();
    await openSettings(this.env, account.tenantId).account.update(
      account.accountId,
      {
        connectionState: "authenticated",
        syncPhase: "complete",
        lastConnectedAt: finishedAt,
        lastSyncAt: finishedAt,
        mailboxCountTotal: this.progress.mailboxesTotal,
        mailboxCountSynced: this.progress.mailboxesTotal,
      },
      ["lastError"],
    );
    log.info("sync finished", {
      event: "sync.complete",
      ...fields,
      ...this.progressFields(),
      messagesQueued: this.progress.dumped,
      durationMs: this.progress.finishedAt - this.progress.startedAt,
      lastMessageSyncAt: new Date(this.progress.finishedAt).toISOString(),
    });
  }

  private async credential(account: MailAccount): Promise<ImapCredential> {
    const [row] = await openSettings(this.env, account.tenantId).account.get([account.accountId]);
    const owned = row?.accountConfigId === account.accountConfigId && row.deletedAt === undefined;
    if (row === undefined || !owned) throw new Error("account no longer exists");
    const password = await accountPassword(tenantSecrets(this.env, account.tenantId), row);
    return accountCredentials(row, password).imap;
  }

  private async passOver(account: MailAccount): Promise<PassOutcome> {
    const client = await openImap(await this.credential(account));
    try {
      return await this.visitMailboxes(client, account);
    } finally {
      client.close();
    }
  }

  private async visitMailboxes(client: ImapFlow, account: MailAccount): Promise<PassOutcome> {
    const started = Date.now();
    const stored = await tenantMail(this.env, account.tenantId).listMailboxItems([
      account.accountId,
    ]);
    const previous = new Map(stored.map((mailbox) => [mailbox.mailboxId, mailbox]));
    const mailboxes = await listServerMailboxes(this.env, client, account);
    const marks = await this.loadMarks();
    await this.advance({ mailboxesTotal: mailboxes.length, ...this.tally(mailboxes, marks) });
    await this.publish(account, {
      syncPhase: "syncing_inbox",
      mailboxCountTotal: mailboxes.length,
      mailboxCountSynced: this.progress.mailboxesDone,
    });
    const offset = mailboxes.length === 0 ? 0 : this.progress.resumeAt % mailboxes.length;
    for (let step = 0; step < mailboxes.length; step += 1) {
      const index = (offset + step) % mailboxes.length;
      const mailbox = mailboxes[index];
      if (mailbox === undefined) continue;
      if (Date.now() - started > PASS_BUDGET_MS) {
        await this.advance({ resumeAt: index });
        return { complete: false };
      }
      await this.advance({ currentMailbox: mailbox.entry.path });
      const result = await syncMailbox(
        this.env,
        client,
        account,
        mailbox,
        previous.get(mailbox.mailboxId),
        marks[mailbox.mailboxId],
        (dumped) =>
          this.advance({
            dumped: this.progress.dumped + dumped,
            batches: this.progress.batches + 1,
          }),
      );
      marks[mailbox.mailboxId] = result.mark;
      await this.ctx.storage.put(MARKS_KEY, marks);
      await this.advance(this.tally(mailboxes, marks));
      await this.publish(account, {
        syncPhase: "syncing_others",
        mailboxCountSynced: this.progress.mailboxesDone,
      });
    }
    await this.advance({ resumeAt: 0 });
    return { complete: this.progress.mailboxesDone === mailboxes.length };
  }

  private tally(mailboxes: readonly ServerMailbox[], marks: MailboxMarks): Tally {
    const since = this.progress.startedAt;
    return mailboxes.reduce<Tally>(
      (total, mailbox) => {
        const mark = marks[mailbox.mailboxId];
        if (mark === undefined || mark.checkedAt < since) return total;
        return {
          mailboxesDone: total.mailboxesDone + (mark.remaining === 0 ? 1 : 0),
          remaining: total.remaining + mark.remaining,
        };
      },
      { mailboxesDone: 0, remaining: 0 },
    );
  }

  private async publish(account: MailAccount, progress: UpdateAccountInput): Promise<void> {
    await openSettings(this.env, account.tenantId).account.update(account.accountId, progress);
  }

  private progressFields(): Record<string, unknown> {
    const { status, ...progress } = this.progress;
    return { ...progress, syncStatus: status };
  }

  private async advance(change: Partial<SyncState>): Promise<void> {
    this.progress = { ...this.progress, ...change, updatedAt: Date.now() };
    await this.save(this.progress);
  }

  private async load(): Promise<SyncState> {
    const stored: unknown = await this.ctx.storage.get(STATE_KEY);
    if (stored === undefined) return NEVER_SYNCED;
    return syncStateSchema.parse(stored);
  }

  private async loadMarks(): Promise<MailboxMarks> {
    const stored: unknown = await this.ctx.storage.get(MARKS_KEY);
    if (stored === undefined) return {};
    return mailboxMarksSchema.parse(stored);
  }

  private save(state: SyncState): Promise<void> {
    return this.ctx.storage.put(STATE_KEY, state);
  }
}
