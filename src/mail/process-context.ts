import type { RemitClient } from "@remit/backend/client";
import type { RemitClientCore } from "@remit/backend/create-remit-client";
import type { SqliteRepositories } from "@remit/drizzle-service";
import {
  type AccountObjectStore,
  type ConnectionPool,
  defaultImapWorkerConfig,
  type ImapEvent,
  type ImapWorkerConfig,
  type ProcessContext,
  type TokenService,
  type WorkerEvent,
  type WorkerMetrics,
  type WorkerQueues,
} from "@remit/imap-worker/process";
import { logger } from "@remit/logger";
import type {
  AppendSentMessageEvent,
  SendMessageContext,
  SmtpDataPorts,
} from "@remit/smtp-worker/process";
import { commit } from "../commit";
import type { Env } from "../env";
import { NotComposedError } from "../error-kind";
import { log } from "../log";
import { queueProducer } from "../queue/producer";
import { attemptsOn } from "../queue/routing";
import { workersSmtpSocket } from "./smtp-connect";

const mutationAttempts = attemptsOn("mutation");

const config: ImapWorkerConfig = {
  ...defaultImapWorkerConfig,
  attempts: {
    body: attemptsOn("sync"),
    placementMove: mutationAttempts,
    flagPush: mutationAttempts,
    appendSent: mutationAttempts,
    messageMove: mutationAttempts,
    messageDelete: mutationAttempts,
    messageCopy: mutationAttempts,
  },
  bodyBatchSize: 25,
  workerVersion: commit,
};

const metrics: WorkerMetrics = {
  imapFailure: (operation, kind, count) =>
    log.warn("imap failure", { event: "imap.failure", operation, failureKind: kind, count }),
};

const oauth: TokenService = {
  getAccessToken: () =>
    Promise.reject(
      new NotComposedError("oauth", "reconnect the account with an app password instead"),
    ),
};

const r2AccountObjects = (bucket: R2Bucket): AccountObjectStore => ({
  list: async (prefix, continuationToken) => {
    const page = await bucket.list(
      continuationToken === undefined ? { prefix } : { prefix, cursor: continuationToken },
    );
    return {
      keys: page.objects.map((object) => object.key),
      nextContinuationToken: page.truncated ? page.cursor : undefined,
    };
  },
  delete: (keys) => bucket.delete(keys),
});

const workerQueues = (env: Env, tenantId: string): WorkerQueues => ({
  mailboxes: queueProducer<"Fifo", ImapEvent>("Fifo", env, tenantId),
  messages: queueProducer<"Fifo", ImapEvent>("Fifo", env, tenantId),
  flags: queueProducer<"Fifo", ImapEvent>("Fifo", env, tenantId),
  body: queueProducer<"Standard", ImapEvent>("Standard", env, tenantId),
  mailboxManagement: queueProducer<"Standard", ImapEvent>("Standard", env, tenantId),
  messageManagement: queueProducer<"Standard", WorkerEvent>("Standard", env, tenantId),
});

export const processContext = (
  env: Env,
  tenantId: string,
  client: RemitClient<"sync">,
  pool: ConnectionPool,
): ProcessContext => ({
  client,
  queues: workerQueues(env, tenantId),
  pool,
  metrics,
  config,
  log: logger,
  oauth,
  accountObjects: r2AccountObjects(env.MAIL),
});

const smtpPorts = (mail: SqliteRepositories): SmtpDataPorts => ({
  account: mail.account,
  outboxMessage: mail.outboxMessage,
  outboxAttachment: mail.outboxAttachment,
  address: mail.address,
  message: mail.message,
  envelope: mail.envelope,
});

const recordSmtpFailure: SendMessageContext["recordSmtpFailure"] = (kind) =>
  log.warn("smtp failure", { event: "smtp.failure", failureKind: kind });

export const sendContext = (
  env: Env,
  tenantId: string,
  mail: SqliteRepositories,
  client: Pick<RemitClientCore, "secrets" | "storage">,
): SendMessageContext => ({
  ports: smtpPorts(mail),
  secrets: client.secrets,
  storage: client.storage,
  messageManagement: queueProducer<"Standard", AppendSentMessageEvent>("Standard", env, tenantId),
  tokenService: oauth,
  getSocket: workersSmtpSocket,
  maxAttempts: attemptsOn("smtp"),
  recordSmtpFailure,
});
