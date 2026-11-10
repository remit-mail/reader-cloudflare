import type {
  IMailboxLockRepository,
  MailboxLease,
  MailboxLockItem,
  WithMailboxLockResult,
} from "@remit/data-ports";
import type { SqliteRepositories } from "@remit/drizzle-service";

export type TenantRepositories = Omit<SqliteRepositories, "mailboxLock"> & {
  readonly mailboxLock: IMailboxLockRepository;
};

const heldUntilReleased: MailboxLease = { renew: async () => {} };

const keyOf = (mailboxId: string, eventName: string): string => `${mailboxId}\u0000${eventName}`;

// The tenant object is the only runner of its syncs, so a lock is held until it
// is released or the instance goes away. The port's ttl is recorded, never enforced.
export class MemoryMailboxLock implements IMailboxLockRepository {
  private readonly locks = new Map<string, MailboxLockItem>();

  async tryAcquireLock(
    mailboxId: string,
    eventName: string,
    accountId: string,
    lockId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = keyOf(mailboxId, eventName);
    if (this.locks.has(key)) return false;
    const now = Date.now();
    this.locks.set(key, {
      mailboxId,
      eventName,
      accountId,
      lockId,
      acquiredAt: now,
      lockedBy: eventName,
      ttl: Math.floor(now / 1000) + ttlSeconds,
    });
    return true;
  }

  async releaseLock(
    accountId: string,
    mailboxId: string,
    eventName: string,
    lockId: string,
  ): Promise<void> {
    const key = keyOf(mailboxId, eventName);
    const held = this.locks.get(key);
    if (held?.accountId === accountId && held.lockId === lockId) this.locks.delete(key);
  }

  async withMailboxLock<T>(
    mailboxId: string,
    eventName: string,
    accountId: string,
    operation: (lease: MailboxLease) => Promise<T>,
    options?: { lockId?: string },
  ): Promise<WithMailboxLockResult<T>> {
    const lockId = options?.lockId ?? crypto.randomUUID();
    const acquired = await this.tryAcquireLock(mailboxId, eventName, accountId, lockId, 0);
    if (!acquired) return { executed: false };
    return operation(heldUntilReleased)
      .then((result) => ({ executed: true as const, result }))
      .finally(() => this.releaseLock(accountId, mailboxId, eventName, lockId));
  }

  async get(
    accountId: string,
    mailboxId: string,
    eventName: string,
  ): Promise<MailboxLockItem | null> {
    const held = this.locks.get(keyOf(mailboxId, eventName));
    return held?.accountId === accountId ? held : null;
  }

  async listAllLocks(): Promise<MailboxLockItem[]> {
    return [...this.locks.values()].sort((a, b) => a.acquiredAt - b.acquiredAt);
  }

  async listByAccount(accountId: string): Promise<MailboxLockItem[]> {
    return [...this.locks.values()].filter((lock) => lock.accountId === accountId);
  }

  async deleteByAccount(accountId: string): Promise<void> {
    for (const [key, lock] of this.locks) {
      if (lock.accountId === accountId) this.locks.delete(key);
    }
  }
}
