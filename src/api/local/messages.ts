import { env } from "cloudflare:workers";
import type {
  BodyPartResponse,
  DescribeMessageResponse,
  EnvelopeAddressResponse,
  MessageReferenceResponse,
} from "@remit/api-openapi-types";
import type { HandlerContext } from "@remit/backend/serve";
import type { AccountItem } from "@remit/data-ports";
import { NotFoundError } from "@remit/data-ports/errors";
import { deriveBodyPartId } from "@remit/data-ports/id";
import type { Context } from "openapi-backend";
import type { Email } from "postal-mime";
import { z } from "zod";
import { messageParts } from "../../content/parts";
import { contentPath } from "../../content/route";
import { senderTrustOf } from "../../mail/address-flags";
import { describeMessage } from "../../mail/operations";
import { parseEmail } from "../../mail/parse";
import type { AddressRole, EnvelopeAddressRecord, MessageRecord } from "../../mail/types";
import { apiConfig } from "../config";
import { r2Storage } from "../storage";
import { ownedAccount } from "./accounts";
import { optional } from "./responses";

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

export const messageHandlers = {
  MessageOperations_describeMessage: describe,
};
