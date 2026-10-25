import {
  AddressRepo,
  DrizzleEnvelopeRepository,
  DrizzleMessageFlagRepository,
  DrizzleMessageRepository,
  DrizzleThreadMessageRepository,
  MailboxRepo,
  OutboxMessageRepo,
  SearchIndex,
  type SqliteStore,
  SyncWarningRepo,
} from "@remit/drizzle-service";

export const composeMailRepositories = (store: SqliteStore<Record<string, unknown>>) => {
  const searchIndex = new SearchIndex(store.db, store);
  return {
    searchIndex,
    address: new AddressRepo(store.db),
    envelope: new DrizzleEnvelopeRepository(store),
    mailbox: new MailboxRepo(store, searchIndex),
    message: new DrizzleMessageRepository(store, searchIndex),
    messageFlag: new DrizzleMessageFlagRepository(store.db),
    outboxMessage: new OutboxMessageRepo(store.db),
    syncWarning: new SyncWarningRepo(store.db),
    threadMessage: new DrizzleThreadMessageRepository(store, searchIndex),
  };
};

export type MailRepositories = ReturnType<typeof composeMailRepositories>;
