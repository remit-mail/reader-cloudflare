import { DurableObject } from "cloudflare:workers";
import type { ImapFlow } from "imapflow";
import { recordSyncOutcome } from "../db/accounts";
import { openAppDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";
import { type ImapCredential, openImap } from "../mail/imap-connect";
import type { MailAccount } from "../mail/types";
import { tenantMail } from "../stubs";
import { listServerMailboxes, syncMailbox } from "./dump";
import { NEVER_SYNCED, type SyncStart, type SyncState, syncStateSchema } from "./state";

const STATE_KEY = "state";

const LOST_RUN = "The sync stopped before it finished. Press Sync to continue where it left off.";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class AccountSync extends DurableObject<Env> {
  private run: Promise<void> | null = null;
  private progress: SyncState = NEVER_SYNCED;

  async status(): Promise<SyncState> {
    if (this.run !== null) return this.progress;
    const stored = await this.load();
    if (stored.status !== "Running") return stored;
    const lost: SyncState = {
      ...stored,
      status: "Failed",
      finishedAt: Date.now(),
      error: LOST_RUN,
    };
    log.error("sync lost", { startedAt: stored.startedAt, currentMailbox: stored.currentMailbox });
    await this.save(lost);
    return lost;
  }

  start(account: MailAccount, credential: ImapCredential): SyncStart {
    if (this.run !== null) return { started: false, state: this.progress };
    this.progress = { ...NEVER_SYNCED, status: "Running", startedAt: Date.now() };
    this.run = this.execute(account, credential).finally(() => {
      this.run = null;
    });
    this.ctx.waitUntil(this.run);
    return { started: true, state: this.progress };
  }

  private async execute(account: MailAccount, credential: ImapCredential): Promise<void> {
    const fields = { tenantId: account.tenantId, accountId: account.accountId };
    await this.save(this.progress);
    log.info("sync started", fields);
    const failure = await this.dump(account, credential).then(
      () => null,
      (error: unknown) => reasonOf(error),
    );
    if (failure !== null) {
      log.error("sync failed", { ...fields, ...this.progress, reason: failure });
      await this.advance({ status: "Failed", finishedAt: Date.now(), error: failure });
      await recordSyncOutcome(openAppDb(this.env.DB), account.accountId, {
        ok: false,
        reason: failure,
      });
      return;
    }
    await this.advance({ status: "Idle", finishedAt: Date.now(), currentMailbox: "" });
    await recordSyncOutcome(openAppDb(this.env.DB), account.accountId, {
      ok: true,
      mailboxes: this.progress.mailboxesTotal,
    });
    log.info("sync finished", {
      ...fields,
      ...this.progress,
      durationMs: this.progress.finishedAt - this.progress.startedAt,
    });
  }

  private async dump(account: MailAccount, credential: ImapCredential): Promise<void> {
    const client = await openImap(credential);
    try {
      await this.dumpMailboxes(client, account);
    } finally {
      client.close();
    }
  }

  private async dumpMailboxes(client: ImapFlow, account: MailAccount): Promise<void> {
    const stored = await tenantMail(this.env, account.tenantId).listMailboxes(account);
    const previous = new Map(stored.map((mailbox) => [mailbox.mailboxId, mailbox]));
    const mailboxes = await listServerMailboxes(this.env, client, account);
    await this.advance({ mailboxesTotal: mailboxes.length });
    for (const mailbox of mailboxes) {
      await this.advance({ currentMailbox: mailbox.entry.path });
      await syncMailbox(
        this.env,
        client,
        account,
        mailbox,
        previous.get(mailbox.mailboxId),
        (dumped) =>
          this.advance({
            dumped: this.progress.dumped + dumped,
            batches: this.progress.batches + 1,
          }),
      );
      await this.advance({ mailboxesDone: this.progress.mailboxesDone + 1 });
    }
  }

  private async advance(change: Partial<SyncState>): Promise<void> {
    this.progress = { ...this.progress, ...change };
    await this.save(this.progress);
  }

  private async load(): Promise<SyncState> {
    const stored: unknown = await this.ctx.storage.get(STATE_KEY);
    if (stored === undefined) return NEVER_SYNCED;
    return syncStateSchema.parse(stored);
  }

  private save(state: SyncState): Promise<void> {
    return this.ctx.storage.put(STATE_KEY, state);
  }
}
