import type {
  BodyPartResponse,
  DescribeMessageResponse,
  EnvelopeAddressResponse,
  MessageBulkOperationResult,
  MessageReferenceResponse,
} from "@remit/api-openapi-types";
import { BulkUpdateFlagsInputSchema } from "@remit/api-zod-schemas";
import type { Email } from "postal-mime";
import { z } from "zod";
import { messageParts } from "../../content/parts";
import { contentPath } from "../../content/route";
import { createContentSigner } from "../../content/signature";
import { type AccountRow, decryptCredential } from "../../db/accounts";
import { openAppDb } from "../../db/client";
import { log } from "../../log";
import { pushFlags } from "../../mail/flags";
import { deriveBodyPartId } from "../../mail/ids";
import { parseEmail } from "../../mail/parse";
import { accountCredentials, settle } from "../../mail/send";
import type {
  AddressRole,
  EnvelopeAddressRecord,
  FlagChange,
  MessageLocation,
  MessageRecord,
} from "../../mail/types";
import { tenantMail } from "../../stubs";
import { type ApiRequest, accountOf, accountsOf, type Handler, parse } from "../request";
import { apiError, invalid, notFound, ok, optional } from "../respond";

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

const loadEmail = async (request: ApiRequest, record: MessageRecord): Promise<Email | null> => {
  if (record.bodyStorageKey === null) return null;
  const object = await request.env.MAIL.get(record.bodyStorageKey);
  if (object === null) throw new Error(`body object ${record.bodyStorageKey} is missing`);
  return parseEmail(object.body);
};

const bodyPartsOf = async (
  request: ApiRequest,
  account: AccountRow,
  record: MessageRecord,
  email: Email | null,
): Promise<BodyPartResponse[]> => {
  if (email === null) return [];
  const sign = await createContentSigner(request.env);
  return Promise.all(
    messageParts(email).map(async (part): Promise<BodyPartResponse> => {
      const path = contentPath(
        account.accountConfigId,
        account.accountId,
        record.messageId,
        part.partPath,
      );
      const { exp, sig } = await sign(path);
      return {
        bodyPartId: await deriveBodyPartId(record.messageId, part.partPath),
        mediaType: part.mediaType,
        mediaSubtype: part.mediaSubtype,
        ...optional("contentId", part.contentId),
        sizeOctets: part.content.byteLength,
        disposition: part.disposition,
        ...optional("dispositionFilename", part.filename),
        isMultipart: false,
        contentUrl: `${request.origin}/content/${path}?exp=${exp}&sig=${sig}`,
      };
    }),
  );
};

const describeMessage: Handler = async (context, request) => {
  const params = parse(messageParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const record = await tenantMail(request.env, request.tenant.tenantId).describeMessage(
    params.value.messageId,
  );
  if (record === null) return notFound("Message");
  const account = await accountOf(request, record.accountId);
  if (account === undefined) return notFound("Message");
  const email = await loadEmail(request, record);
  const body: DescribeMessageResponse = {
    message: {
      messageId: record.messageId,
      mailboxId: record.mailboxId,
      uid: record.uid,
      rfc822Size: record.rfc822Size,
      internalDate: record.internalDate,
      ...optional("messageIdHeader", record.messageIdHeader),
      status: record.status,
      syncStatus: record.syncStatus,
      abandonedMutation: record.abandonedMutation,
    },
    envelope: {
      messageId: record.messageId,
      date: record.date,
      ...optional("subject", record.subject),
      ...optional("messageIdValue", record.messageIdValue),
      from: addressesFor(record.addresses, "from"),
      to: addressesFor(record.addresses, "to"),
      cc: addressesFor(record.addresses, "cc"),
      bcc: addressesFor(record.addresses, "bcc"),
      replyTo: addressesFor(record.addresses, "reply_to"),
      category: record.category,
      senderTrust: "unknown",
    },
    flags: [...record.flags],
    bodyParts: await bodyPartsOf(request, account, record, email),
    references: referencesOf(email),
  };
  return ok(body);
};

const byAccount = (locations: readonly MessageLocation[]): Map<string, MessageLocation[]> => {
  const groups = new Map<string, MessageLocation[]>();
  for (const location of locations) {
    groups.set(location.accountId, [...(groups.get(location.accountId) ?? []), location]);
  }
  return groups;
};

type PushResult =
  | { readonly ok: true; readonly messageIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const pushAccount = async (
  request: ApiRequest,
  account: AccountRow,
  locations: readonly MessageLocation[],
  change: FlagChange,
): Promise<PushResult> => {
  const secret = await decryptCredential(
    request.env,
    openAppDb(request.env.DB),
    request.tenant.tenantId,
    account.accountId,
  );
  if (!secret.ok) return { ok: false, reason: secret.reason };
  const pushed = await settle(
    pushFlags(accountCredentials(account, secret.plaintext).imap, locations, change),
  );
  if (!pushed.ok) return { ok: false, reason: pushed.reason };
  return { ok: true, messageIds: locations.map((location) => location.messageId) };
};

const updateFlags: Handler = async (_context, request) => {
  const parsed = parse(BulkUpdateFlagsInputSchema, request.body, "flag update");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  if (input.messageIds.length === 0 || input.messageIds.length > MAX_BULK) {
    return invalid(`messageIds must hold between 1 and ${MAX_BULK} ids`);
  }
  const change: FlagChange = {
    isRead: input.isRead ?? null,
    isStarred: input.isStarred ?? null,
  };
  const mail = tenantMail(request.env, request.tenant.tenantId);
  const accounts = new Map(
    (await accountsOf(request)).map((account) => [account.accountId, account]),
  );
  const located = (await mail.locateMessages(input.messageIds)).filter((location) =>
    accounts.has(location.accountId),
  );
  const results = await Promise.all(
    [...byAccount(located)].flatMap(([accountId, locations]) => {
      const account = accounts.get(accountId);
      return account === undefined ? [] : [pushAccount(request, account, locations, change)];
    }),
  );
  const pushed = results.flatMap((result) => (result.ok ? result.messageIds : []));
  const failures = results.flatMap((result) => (result.ok ? [] : [result.reason]));
  if (pushed.length > 0) await mail.setFlags(pushed, change);
  if (failures.length > 0) {
    log.error("flag push failed", { tenantId: request.tenant.tenantId, reasons: failures });
    return apiError(
      502,
      "ImapFlagPushFailed",
      `The mail server refused the change: ${failures.join("; ")}`,
    );
  }
  const body: MessageBulkOperationResult = {
    successCount: pushed.length,
    failureCount: input.messageIds.length - pushed.length,
  };
  return ok(body);
};

export const messageHandlers = {
  MessageOperations_describeMessage: describeMessage,
  MessageBulkOperations_updateFlags: updateFlags,
} satisfies Record<string, Handler>;
