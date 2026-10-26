import type { RemitClient } from "@remit/backend/client";
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
import { commit } from "../commit";
import type { Env } from "../env";
import { NotComposedError } from "../error-kind";
import { log } from "../log";
import { queueProducer } from "../queue/producer";
import { attemptsOn } from "../queue/routing";

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
