import {
  CreateOutboxMessageInputSchema,
  UpdateOutboxMessageInputSchema,
} from "@remit/api-zod-schemas";
import { z } from "zod";
import { type AccountRow, decryptCredential } from "../../db/accounts";
import { openAppDb } from "../../db/client";
import { log } from "../../log";
import { accountCredentials, deliver, domainOf } from "../../mail/send";
import type { OutboxDraft, OutboxRecord } from "../../mail/types";
import { tenantMail } from "../../stubs";
import { toOutboxMessageResponse } from "../mappers";
import {
  type ApiRequest,
  accountConfigOf,
  accountOf,
  accountsOf,
  type Handler,
  mailAccountsOf,
  parse,
} from "../request";
import { apiError, invalid, notFound, ok } from "../respond";

const outboxParams = z.object({ outboxMessageId: z.string().min(1) });

const orNull = (value: string | undefined): string | null => value ?? null;

const send = async (
  request: ApiRequest,
  account: AccountRow,
  outboxMessageId: string,
): Promise<Response> => {
  const mail = tenantMail(request.env, request.tenant.tenantId);
  const claimed = await mail.claimOutbox(account.accountConfigId, outboxMessageId);
  if (!claimed.ok) return apiError(409, "OutboxNotSendable", claimed.reason);
  const fields = {
    event: "smtp.send",
    tenantId: request.tenant.tenantId,
    accountId: account.accountId,
    outboxMessageId,
  };
  const secret = await decryptCredential(
    request.env,
    openAppDb(request.env.DB),
    request.tenant.tenantId,
    account.accountId,
  );
  if (!secret.ok) {
    await mail.settleOutbox(account.accountConfigId, outboxMessageId, {
      status: "failed",
      lastError: secret.reason,
      sentAt: null,
    });
    log.error("send failed", {
      ...fields,
      sendStatus: "CredentialUnavailable",
      errorKind: "credential",
      durationMs: 0,
      reason: secret.reason,
    });
    return apiError(500, "CredentialUnavailable", secret.reason);
  }
  const started = Date.now();
  const delivery = await deliver(accountCredentials(account, secret.plaintext), claimed.value);
  const durationMs = Date.now() - started;
  if (delivery.kind === "Failed") {
    await mail.settleOutbox(account.accountConfigId, outboxMessageId, {
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
    return apiError(
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
    const unfiled = await mail.settleOutbox(account.accountConfigId, outboxMessageId, {
      status: "unfiled",
      lastError: delivery.reason,
      sentAt,
    });
    return ok(toOutboxMessageResponse(unfiled));
  }
  log.info("message sent", {
    ...fields,
    sendStatus: "Sent",
    durationMs,
    sentMailbox: delivery.sentMailbox,
  });
  const sent = await mail.settleOutbox(account.accountConfigId, outboxMessageId, {
    status: "sent",
    lastError: null,
    sentAt,
  });
  return ok(toOutboxMessageResponse(sent));
};

const createOutbox: Handler = async (_context, request) => {
  const parsed = parse(CreateOutboxMessageInputSchema, request.body, "outbox message");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  if (input.toAddresses.length === 0) return invalid("At least one recipient is required");
  const account = await accountOf(request, input.accountId);
  if (account === undefined) return notFound("Account");
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
  const created = await tenantMail(request.env, request.tenant.tenantId).createOutbox({
    accountId: account.accountId,
    accountConfigId: account.accountConfigId,
    fromAddress: account.email,
    messageIdValue: `<${crypto.randomUUID()}@${domainOf(account.email)}>`,
    draft,
  });
  if (input.sendImmediately === true) return send(request, account, created.outboxMessageId);
  return ok(toOutboxMessageResponse(created));
};

const listOutbox: Handler = async (_context, request) => {
  const accounts = await accountsOf(request);
  const records = await tenantMail(request.env, request.tenant.tenantId).listOutbox(
    accounts.map((account) => account.accountId),
  );
  return ok({ items: records.map(toOutboxMessageResponse) });
};

type Owned =
  | { readonly ok: true; readonly record: OutboxRecord; readonly account: AccountRow }
  | { readonly ok: false; readonly response: Response };

const ownedOutbox = async (request: ApiRequest, params: unknown): Promise<Owned> => {
  const parsed = parse(outboxParams, params, "path");
  if (!parsed.ok) return parsed;
  const accountConfigId = accountConfigOf(await mailAccountsOf(request));
  if (accountConfigId === null) return { ok: false, response: notFound("Outbox message") };
  const record = await tenantMail(request.env, request.tenant.tenantId).getOutbox(
    accountConfigId,
    parsed.value.outboxMessageId,
  );
  if (record === null) return { ok: false, response: notFound("Outbox message") };
  const account = await accountOf(request, record.accountId);
  if (account === undefined) return { ok: false, response: notFound("Outbox message") };
  return { ok: true, record, account };
};

const getOutbox: Handler = async (context, request) => {
  const owned = await ownedOutbox(request, context.request.params);
  if (!owned.ok) return owned.response;
  return ok(toOutboxMessageResponse(owned.record));
};

const updateOutbox: Handler = async (context, request) => {
  const owned = await ownedOutbox(request, context.request.params);
  if (!owned.ok) return owned.response;
  const parsed = parse(UpdateOutboxMessageInputSchema, request.body, "outbox update");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  if (input.attachmentIds !== undefined && input.attachmentIds.length > 0) {
    return invalid("Attachments are not supported yet");
  }
  const { record } = owned;
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
  const updated = await tenantMail(request.env, request.tenant.tenantId).updateOutboxDraft(
    record.accountConfigId,
    record.outboxMessageId,
    draft,
  );
  if (!updated.ok) return apiError(409, "OutboxNotEditable", updated.reason);
  return ok(toOutboxMessageResponse(updated.value));
};

const sendOutbox: Handler = async (context, request) => {
  const owned = await ownedOutbox(request, context.request.params);
  if (!owned.ok) return owned.response;
  if (owned.record.toAddresses.length === 0) return invalid("At least one recipient is required");
  return send(request, owned.account, owned.record.outboxMessageId);
};

export const outboxHandlers = {
  OutboxOperations_createOutboxMessage: createOutbox,
  OutboxOperations_listOutboxMessages: listOutbox,
  OutboxDetailOperations_getOutboxMessage: getOutbox,
  OutboxDetailOperations_updateOutboxMessage: updateOutbox,
  OutboxDetailOperations_sendOutboxMessage: sendOutbox,
} satisfies Record<string, Handler>;
