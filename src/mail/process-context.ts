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
import { microsoftTokens } from "../api/config";
import {
  BODY_BATCH_SIZE,
  BODY_PROCESS_BYTES_IN_FLIGHT,
  BODY_PROCESS_CONCURRENCY,
} from "../api/host-limits";
import { commit } from "../commit";
import type { Env } from "../env";
import { log } from "../log";
import { queueProducer } from "../queue/producer";
import { attemptsOn } from "../queue/routing";
import { workersSmtpSocket } from "./smtp-connect";

const mutationAttempts = attemptsOn("mutation");

const config: ImapWorkerConfig = {
  ...defaultImapWorkerConfig,
  attempts: {
    body: attemptsOn("body"),
    placementMove: mutationAttempts,
    flagPush: mutationAttempts,
    appendSent: mutationAttempts,
    messageMove: mutationAttempts,
    messageDelete: mutationAttempts,
    messageCopy: mutationAttempts,
  },
  bodyBatchSize: BODY_BATCH_SIZE,
  bodyProcessConcurrency: BODY_PROCESS_CONCURRENCY,
  bodyProcessBytesInFlight: BODY_PROCESS_BYTES_IN_FLIGHT,
  workerVersion: commit,
};

const metrics: WorkerMetrics = {
  imapFailure: (operation, kind, count) =>
    log.warn("imap failure", { event: "imap.failure", operation, failureKind: kind, count }),
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
  oauth: microsoftTokens,
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
  tokenService: microsoftTokens,
  getSocket: workersSmtpSocket,
  maxAttempts: attemptsOn("smtp"),
  recordSmtpFailure,
});
