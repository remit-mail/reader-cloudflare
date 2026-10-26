import { env } from "cloudflare:workers";
import type {
  BodyPartResponse,
  DescribeMessageResponse,
  EnvelopeAddressResponse,
  MessageBulkOperationResult,
  MessageReferenceResponse,
} from "@remit/api-openapi-types";
import { BulkUpdateFlagsInputSchema, UpdateFlagsInputSchema } from "@remit/api-zod-schemas";
import type { HandlerContext } from "@remit/backend/serve";
import type { AccountItem } from "@remit/data-ports";
import { BadRequestError, NotFoundError } from "@remit/data-ports/errors";
import { deriveBodyPartId } from "@remit/data-ports/id";
import type { Context } from "openapi-backend";
import type { Email } from "postal-mime";
import { z } from "zod";
import { messageParts } from "../../content/parts";
import { contentPath } from "../../content/route";
import { accountPassword } from "../../crypto/envelope";
import { log } from "../../log";
import { senderTrustOf } from "../../mail/address-flags";
import { pushFlags } from "../../mail/flags";
import { describeMessage, flagState, locateMessages, setFlags } from "../../mail/operations";
import { parseEmail } from "../../mail/parse";
import { accountCredentials, settle } from "../../mail/send";
import type {
  AddressRole,
  EnvelopeAddressRecord,
  FlagChange,
  MessageLocation,
  MessageRecord,
} from "../../mail/types";
import { apiConfig } from "../config";
import { r2Storage } from "../storage";
import { accountsOf, ownedAccount } from "./accounts";
import { optional } from "./responses";

const MAX_BULK = 100;

const messageParams = z.object({ messageId: z.string().min(1) });

const addressesFor = (
  addresses: readonly EnvelopeAddressRecord[],
  role: AddressRole,
): EnvelopeAddressResponse[] =>
  addresses
    .filter((address) => address.role === role)
    .map((address) => ({
      addressId: address.addressId,
      ...optional("displayName", address.displayName),
      normalizedEmail: address.email,
      addressRole: address.role,
      addressOrder: address.order,
      flags: address.flags,
    }));

const referencesOf = (email: Email | null): MessageReferenceResponse[] => {
  if (email === null) return [];
  const inReplyTo: MessageReferenceResponse[] =
    email.inReplyTo === undefined || email.inReplyTo === ""
      ? []
      : [{ messageIdValue: email.inReplyTo, referenceType: "in_reply_to", referenceOrder: 0 }];
  const references = (email.references ?? "")
    .split(/\s+/)
    .filter((value) => value !== "")
    .map(
      (messageIdValue, referenceOrder): MessageReferenceResponse => ({
        messageIdValue,
        referenceType: "references",
        referenceOrder,
      }),
    );
  return [...inReplyTo, ...references];
};

const loadEmail = async (record: MessageRecord): Promise<Email | null> => {
  const key = record.message.bodyStorageKey;
  if (key === undefined) return null;
  return parseEmail(await r2Storage(env.MAIL).retrieve(key));
};

const bodyPartsOf = (
  account: AccountItem,
  record: MessageRecord,
  email: Email | null,
): BodyPartResponse[] => {
  if (email === null) return [];
  return messageParts(email).map((part): BodyPartResponse => {
    const path = contentPath(
      account.accountConfigId,
      account.accountId,
      record.message.messageId,
      part.partPath,
    );
    return {
      bodyPartId: deriveBodyPartId(record.message.messageId, part.partPath),
      partPath: part.partPath,
      mediaType: part.mediaType,
      mediaSubtype: part.mediaSubtype,
      ...optional("contentId", part.contentId),
      sizeOctets: part.content.byteLength,
      disposition: part.disposition,
      ...optional("dispositionFilename", part.filename),
      isMultipart: false,
      contentUrl: `${apiConfig.publicOrigin}/content/${path}`,
    };
  });
};

const describe = async (context: Context, ctx: HandlerContext) => {
  const { messageId } = messageParams.parse(context.request.params);
  const record = await describeMessage(ctx.client, ctx.identity.accountConfigId, messageId);
  if (record === null) throw new NotFoundError("Message not found");
  const account = await ownedAccount(ctx, record.accountId);
  const email = await loadEmail(record);
  const { message } = record;
  const body: DescribeMessageResponse = {
    message: {
      messageId: message.messageId,
      mailboxId: message.mailboxId,
      uid: message.uid,
      rfc822Size: message.rfc822Size,
      internalDate: message.internalDate,
      ...optional("messageIdHeader", record.messageIdValue),
      status: message.status,
      syncStatus: message.syncStatus,
      abandonedMutation: message.abandonedMutation,
    },
    envelope: {
      messageId: message.messageId,
      date: record.date,
      ...optional("subject", record.subject),
      ...optional("messageIdValue", record.messageIdValue),
      from: addressesFor(record.addresses, "from"),
      to: addressesFor(record.addresses, "to"),
      cc: addressesFor(record.addresses, "cc"),
      bcc: addressesFor(record.addresses, "bcc"),
      replyTo: addressesFor(record.addresses, "reply_to"),
      category: message.category,
      senderTrust: senderTrustOf(
        record.addresses.find((address) => address.role === "from")?.flags ?? {},
      ),
    },
    flags: [...record.flags],
    bodyParts: bodyPartsOf(account, record, email),
    references: referencesOf(email),
  };
  return body;
};

const byAccount = (locations: readonly MessageLocation[]): Map<string, MessageLocation[]> => {
  const groups = new Map<string, MessageLocation[]>();
  for (const location of locations) {
    groups.set(location.accountId, [...(groups.get(location.accountId) ?? []), location]);
  }
  return groups;
};

const pushAccount = async (
  ctx: HandlerContext,
  account: AccountItem,
  locations: readonly MessageLocation[],
  change: FlagChange,
) => {
  const password = await accountPassword(ctx.client.secrets, account);
  const pushed = await settle(
    pushFlags(accountCredentials(account, password).imap, locations, change),
  );
  if (!pushed.ok) return { ok: false as const, reason: pushed.reason };
  return { ok: true as const, messageIds: locations.map((location) => location.messageId) };
};

const pushFailure = (reasons: readonly string[]) => ({
  statusCode: 502,
  body: {
    code: "ImapFlagPushFailed",
    message: `The mail server refused the change: ${reasons.join("; ")}`,
  },
});

type FlagOutcome =
  | { readonly ok: true; readonly pushed: readonly string[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

const applyFlagChange = async (
  ctx: HandlerContext,
  messageIds: readonly string[],
  change: FlagChange,
): Promise<FlagOutcome> => {
  const accounts = new Map((await accountsOf(ctx)).map((account) => [account.accountId, account]));
  const located = (await locateMessages(ctx.client, messageIds)).filter((location) =>
    accounts.has(location.accountId),
  );
  const results = await Promise.all(
    [...byAccount(located)].flatMap(([accountId, locations]) => {
      const account = accounts.get(accountId);
      return account === undefined ? [] : [pushAccount(ctx, account, locations, change)];
    }),
  );
  const pushed = results.flatMap((result) => (result.ok ? result.messageIds : []));
  const reasons = results.flatMap((result) => (result.ok ? [] : [result.reason]));
  if (pushed.length > 0) await setFlags(ctx.client, ctx.identity.accountConfigId, pushed, change);
  if (reasons.length === 0) return { ok: true, pushed };
  log.error("flag push failed", { event: "imap.flags", errorKind: "imap", reasons });
  return { ok: false, reasons };
};

const updateFlags = async (context: Context, ctx: HandlerContext) => {
  const input = BulkUpdateFlagsInputSchema.parse(context.request.requestBody);
  if (input.messageIds.length === 0 || input.messageIds.length > MAX_BULK) {
    throw new BadRequestError(`messageIds must hold between 1 and ${MAX_BULK} ids`);
  }
  const outcome = await applyFlagChange(ctx, input.messageIds, {
    isRead: input.isRead ?? null,
    isStarred: input.isStarred ?? null,
  });
  if (!outcome.ok) return pushFailure(outcome.reasons);
  const body: MessageBulkOperationResult = {
    successCount: outcome.pushed.length,
    failureCount: input.messageIds.length - outcome.pushed.length,
  };
  return body;
};

const updateMessageFlags = async (context: Context, ctx: HandlerContext) => {
  const { messageId } = messageParams.parse(context.request.params);
  const input = UpdateFlagsInputSchema.parse(context.request.requestBody);
  const outcome = await applyFlagChange(ctx, [messageId], {
    isRead: input.isRead ?? null,
    isStarred: input.isStarred ?? null,
  });
  if (!outcome.ok) return pushFailure(outcome.reasons);
  if (outcome.pushed.length === 0) throw new NotFoundError("Message not found");
  const state = await flagState(ctx.client, ctx.identity.accountConfigId, messageId);
  if (state === null) throw new NotFoundError("Message not found");
  return state;
};

export const messageHandlers = {
  MessageOperations_describeMessage: describe,
  MessageOperations_updateMessageFlags: updateMessageFlags,
  MessageBulkOperations_updateFlags: updateFlags,
};
