import { DurableObject } from "cloudflare:workers";
import {
  type AccountPurgeContext,
  processAccountFanoutEvent,
  processAccountPurgeEvent,
} from "@remit/account-worker/process";
import type { RemitClient } from "@remit/backend/client";
import { createRemitClient } from "@remit/backend/create-remit-client";
import type { UserIdentity } from "@remit/backend/serve";
import {
  composeSqliteRepositories,
  type SqliteRepositories,
  type SqliteStores,
  syncStore,
} from "@remit/drizzle-service";
import { type ConnectionPool, type ProcessContext, processEvent } from "@remit/imap-worker/process";
import type { SchedulerTickResult } from "@remit/imap-worker/scheduler-tick";
import { handleSendMessage, type SendMessageContext } from "@remit/smtp-worker/process";
import { drizzle } from "drizzle-orm/durable-sqlite";
import migrations from "../../migrations/mail/migrations";
import { CLOUDFLARE_SQLITE_LIMITS } from "../api/host-limits";
import { serveTenantApi } from "../api/serve";
import { r2Storage } from "../api/storage";
import { tenantSecrets } from "../crypto/envelope";
import { openAppStore } from "../db/client";
import { migrateDurableObject } from "../db/durable-migrate";
import type { Env } from "../env";
import { errorKindOf, messageOf } from "../error-kind";
import { type ConsumeReport, withLogContext } from "../log";
import { queueProducer } from "../queue/producer";
import type { EventOn, QueueEnvelope, QueueFamily, ReaderEvent } from "../queue/routing";
import { purgeContext } from "./account-purge";
import { connectImap, pooledConnectionScope, workersTransport } from "./imap-connect";
import { metered, meteredPool } from "./pool";
import { processContext, sendContext } from "./process-context";
import { schedulerTick } from "./scheduler-tick";
import { workersSmtpSocket } from "./smtp-connect";

class UnservedEventError extends Error {
  readonly family: QueueFamily;
  readonly type: ReaderEvent["type"];

  constructor(family: QueueFamily, type: ReaderEvent["type"]) {
    super(`the ${family} queue has no consumer for ${type} in this Worker yet`);
    this.name = "UnservedEventError";
    this.family = family;
    this.type = type;
  }
}

interface Composed {
  readonly tenantId: string;
  readonly client: RemitClient;
  readonly process: ProcessContext;
  readonly send: SendMessageContext;
  readonly purge: AccountPurgeContext;
}

const accountOf = (event: ReaderEvent): Record<string, string> =>
  "accountId" in event && typeof event.accountId === "string" ? { accountId: event.accountId } : {};

const consumeFanout = (event: ReaderEvent, composed: Composed): Promise<void> => {
  switch (event.type) {
    case "OrganizeJob":
    case "SenderCategoryBackApply":
      return processAccountFanoutEvent(event, { client: composed.client });
    case "AccountDataPurge":
    case "FinalizeAccountDataPurge":
      return processAccountPurgeEvent(event, composed.purge);
    default:
      throw new UnservedEventError("fanout", event.type);
  }
};

const consumeSync = (
  event: ReaderEvent,
  context: ProcessContext,
  attempts: number,
): Promise<void> => {
  switch (event.type) {
    case "SYNC_MAILBOXES":
    case "SYNC_MESSAGES":
      return processEvent(event, context, attempts);
    default:
      throw new UnservedEventError("sync", event.type);
  }
};

const consumeBody = (
  event: ReaderEvent,
  context: ProcessContext,
  attempts: number,
): Promise<void> => {
  switch (event.type) {
    case "SYNC_MESSAGE_BODY":
      return processEvent(event, context, attempts);
    default:
      throw new UnservedEventError("body", event.type);
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

const consumeSmtp = (
  event: ReaderEvent,
  context: SendMessageContext,
  attempts: number,
): Promise<void> => {
  switch (event.type) {
    case "SEND_MESSAGE":
      return handleSendMessage(event, context, attempts);
    default:
      throw new UnservedEventError("smtp", event.type);
  }
};

export class TenantMail extends DurableObject<Env> {
  private readonly mail: SqliteRepositories;
  private readonly stores: SqliteStores;
  private readonly pool: ConnectionPool;
  private composed: Composed | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    const mail = syncStore(db, CLOUDFLARE_SQLITE_LIMITS);
    this.stores = { app: openAppStore(env.DB, CLOUDFLARE_SQLITE_LIMITS), mail, search: mail };
    this.mail = composeSqliteRepositories(this.stores);
    this.pool = meteredPool({ size: 1, overflow: "Wait" }, connectImap);
    void ctx.blockConcurrencyWhile(() => migrateDurableObject(db, migrations));
  }

  async api(request: Request, identity: UserIdentity, correlationId: string): Promise<Response> {
    return withLogContext({ correlationId, tenantId: identity.sub }, () =>
      serveTenantApi(request, identity, this.compose(identity.sub).client, correlationId),
    );
  }

  async consume(
    family: QueueFamily,
    envelope: QueueEnvelope,
    attempts: number,
  ): Promise<ConsumeReport> {
    const { tenantId, correlationId, event } = envelope;
    const meter = { waitedMs: 0 };
    const fields = { correlationId, tenantId, family, attempt: attempts, ...accountOf(event) };
    return withLogContext(fields, () =>
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

  async schedulerTick(
    tenantId: string,
    now: number,
    correlationId: string,
  ): Promise<SchedulerTickResult> {
    return withLogContext({ correlationId, tenantId }, () => {
      const composed = this.compose(tenantId);
      return schedulerTick(composed.client, composed.process, now);
    });
  }

  private async dispatch(
    family: QueueFamily,
    event: ReaderEvent,
    tenantId: string,
    attempts: number,
  ): Promise<void> {
    const composed = this.compose(tenantId);
    switch (family) {
      case "fanout":
        return consumeFanout(event, composed);
      case "sync":
        return consumeSync(event, composed.process, attempts);
      case "body":
        return consumeBody(event, composed.process, attempts);
      case "mutation":
        return consumeMutation(event, composed.process, attempts);
      case "smtp":
        return consumeSmtp(event, composed.send, attempts);
    }
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
      send: sendContext(this.env, tenantId, this.mail, client),
      purge: purgeContext(this.env, tenantId, client, this.stores),
    };
    return this.composed;
  }

  private clientOf(tenantId: string): RemitClient {
    return createRemitClient({
      repositories: this.mail,
      storage: r2Storage(this.env.MAIL),
      secrets: tenantSecrets(this.env, tenantId),
      connectionScope: pooledConnectionScope(this.pool),
      mailTransports: { imap: workersTransport, smtp: workersSmtpSocket },
      queues: {
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
        smtp: queueProducer<"Standard", EventOn<"smtp">>("Standard", this.env, tenantId),
        body: queueProducer<"Standard", EventOn<"body">>("Standard", this.env, tenantId),
      },
    });
  }
}
