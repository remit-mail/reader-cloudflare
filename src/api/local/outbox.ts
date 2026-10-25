import {
  CreateOutboxMessageInputSchema,
  UpdateOutboxMessageInputSchema,
} from "@remit/api-zod-schemas";
import { handlers } from "@remit/backend/handlers";
import type { HandlerContext } from "@remit/backend/serve";
import type { AccountItem } from "@remit/data-ports";
import { BadRequestError, NotFoundError } from "@remit/data-ports/errors";
import type { Context } from "openapi-backend";
import { z } from "zod";
import { accountPassword } from "../../crypto/envelope";
import { log } from "../../log";
import { claimOutbox, createOutbox, settleOutbox, updateOutboxDraft } from "../../mail/operations";
import { accountCredentials, deliver, domainOf, settle } from "../../mail/send";
import type { OutboxDraft, OutboxRecord } from "../../mail/types";
import { ownedAccount } from "./accounts";

const outboxParams = z.object({ outboxMessageId: z.string().min(1) });

const orNull = (value: string | undefined): string | null => value ?? null;

const refused = (statusCode: number, code: string, message: string) => ({
  statusCode,
  body: { code, message },
});

const outboxResponse = (context: Context, ctx: HandlerContext, outboxMessageId: string) =>
  handlers.OutboxDetailOperations_getOutboxMessage(
    { ...context, request: { ...context.request, params: { outboxMessageId } } },
    ctx,
  );

const send = async (
  context: Context,
  ctx: HandlerContext,
  account: AccountItem,
  outboxMessageId: string,
) => {
  const claimed = await claimOutbox(ctx.client, account.accountConfigId, outboxMessageId);
  if (!claimed.ok) return refused(409, "OutboxNotSendable", claimed.reason);
  const fields = {
    event: "smtp.send",
    tenantId: ctx.identity.sub,
    accountId: account.accountId,
    outboxMessageId,
  };
  const password = await settle(accountPassword(ctx.client.secrets, account));
  if (!password.ok) {
    await settleOutbox(ctx.client, account.accountConfigId, outboxMessageId, {
      status: "failed",
      lastError: password.reason,
      sentAt: null,
    });
    log.error("send failed", {
      ...fields,
      sendStatus: "CredentialUnavailable",
      errorKind: "credential",
      durationMs: 0,
      reason: password.reason,
    });
    return refused(500, "CredentialUnavailable", password.reason);
  }
  const started = Date.now();
  const delivery = await deliver(accountCredentials(account, password.value), claimed.value);
  const durationMs = Date.now() - started;
  if (delivery.kind === "Failed") {
    await settleOutbox(ctx.client, account.accountConfigId, outboxMessageId, {
      status: "failed",
      lastError: delivery.reason,
      sentAt: null,
    });
    log.error("send failed", {
      ...fields,
      sendStatus: "Failed",
      errorKind: "smtp",
      durationMs,
      reason: delivery.reason,
    });
    return refused(
      502,
      "SmtpSendFailed",
      `The mail server refused the message: ${delivery.reason}`,
    );
  }
  const sentAt = Date.now();
  if (delivery.kind === "Unfiled") {
    log.error("sent copy not appended", {
      ...fields,
      sendStatus: "Unfiled",
      errorKind: "imap",
      durationMs,
      reason: delivery.reason,
    });
    await settleOutbox(ctx.client, account.accountConfigId, outboxMessageId, {
      status: "unfiled",
      lastError: delivery.reason,
      sentAt,
    });
    return outboxResponse(context, ctx, outboxMessageId);
  }
  log.info("message sent", {
    ...fields,
    sendStatus: "Sent",
    durationMs,
    sentMailbox: delivery.sentMailbox,
  });
  await settleOutbox(ctx.client, account.accountConfigId, outboxMessageId, {
    status: "sent",
    lastError: null,
    sentAt,
  });
  return outboxResponse(context, ctx, outboxMessageId);
};

const create = async (context: Context, ctx: HandlerContext) => {
  const input = CreateOutboxMessageInputSchema.parse(context.request.requestBody);
  if (input.toAddresses.length === 0) {
    throw new BadRequestError("At least one recipient is required");
  }
  const account = await ownedAccount(ctx, input.accountId);
  const draft: OutboxDraft = {
    toAddresses: input.toAddresses,
    ccAddresses: input.ccAddresses ?? [],
    bccAddresses: input.bccAddresses ?? [],
    subject: orNull(input.subject),
    textBody: orNull(input.textBody),
    htmlBody: orNull(input.htmlBody),
    inReplyTo: orNull(input.inReplyTo),
    references: input.references ?? [],
  };
  const created = await createOutbox(ctx.client, {
    accountId: account.accountId,
    accountConfigId: account.accountConfigId,
    fromAddress: account.email,
    messageIdValue: `<${crypto.randomUUID()}@${domainOf(account.email)}>`,
    draft,
  });
  if (input.sendImmediately === true) {
    return send(context, ctx, account, created.outboxMessageId);
  }
  return outboxResponse(context, ctx, created.outboxMessageId);
};

interface Owned {
  readonly record: OutboxRecord;
  readonly account: AccountItem;
}

const ownedOutbox = async (context: Context, ctx: HandlerContext): Promise<Owned> => {
  const { outboxMessageId } = outboxParams.parse(context.request.params);
  const [record] = await ctx.client.outboxMessage.get(ctx.identity.accountConfigId, [
    outboxMessageId,
  ]);
  if (record === undefined) throw new NotFoundError("Outbox message not found");
  return { record, account: await ownedAccount(ctx, record.accountId) };
};

const update = async (context: Context, ctx: HandlerContext) => {
  const { record } = await ownedOutbox(context, ctx);
  const input = UpdateOutboxMessageInputSchema.parse(context.request.requestBody);
  if (input.attachmentIds !== undefined && input.attachmentIds.length > 0) {
    throw new BadRequestError("Attachments are not supported yet");
  }
  const draft: OutboxDraft = {
    toAddresses: input.toAddresses ?? record.toAddresses,
    ccAddresses: input.ccAddresses ?? record.ccAddresses,
    bccAddresses: input.bccAddresses ?? record.bccAddresses,
    subject: input.subject ?? record.subject ?? null,
    textBody: input.textBody ?? record.textBody ?? null,
    htmlBody: input.htmlBody ?? record.htmlBody ?? null,
    inReplyTo: input.inReplyTo ?? record.inReplyTo ?? null,
    references: input.references ?? record.references,
  };
  const updated = await updateOutboxDraft(
    ctx.client,
    record.accountConfigId,
    record.outboxMessageId,
    draft,
  );
  if (!updated.ok) return refused(409, "OutboxNotEditable", updated.reason);
  return outboxResponse(context, ctx, record.outboxMessageId);
};

const sendOutbox = async (context: Context, ctx: HandlerContext) => {
  const { record, account } = await ownedOutbox(context, ctx);
  if (record.toAddresses.length === 0) {
    throw new BadRequestError("At least one recipient is required");
  }
  return send(context, ctx, account, record.outboxMessageId);
};

export const outboxHandlers = {
  OutboxOperations_createOutboxMessage: create,
  OutboxDetailOperations_updateOutboxMessage: update,
  OutboxDetailOperations_sendOutboxMessage: sendOutbox,
};
