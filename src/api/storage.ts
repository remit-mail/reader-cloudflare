import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { ContentEncoding, StorageType } from "@remit/domain-enums";
import {
  buildBodyPartKey,
  buildDeduplicatedKey,
  buildExportArchiveKey,
  buildMessageBodyKey,
  buildOutboxAttachmentKey,
  buildOutboxAttachmentPrefix,
  buildParsedBodyKey,
  buildStorageUri,
  computeChecksum,
  type ParsedBody,
  parseStorageUri,
  type StorageReference,
  type StorageService,
  UPLOAD_ROUTE_PREFIX,
} from "@remit/storage-service";
import { z } from "zod";
import { CONTENT_PREFIX } from "../content/route";

const STORAGE_URI_BUCKET_LABEL = "reader-cloudflare-mail";
const EXPORT_PART_BYTES = 8 * 1024 * 1024;

const parsedBodySchema = z.object({
  text: z.string().nullable(),
  html: z.string().nullable(),
  attachments: z.array(
    z.object({
      filename: z.string().nullable(),
      contentType: z.string(),
      contentDisposition: z.string().nullable(),
      contentId: z.string().nullable(),
      size: z.number(),
    }),
  ),
});

// R2 stores a stream only when its length is known up front, which a zip being
// written is not, so the archive goes up as a multipart upload.
const uploadInParts = async (bucket: R2Bucket, key: string, body: Readable): Promise<void> => {
  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/zip" },
  });
  const parts: R2UploadedPart[] = [];
  const uploadPart = async (bytes: Uint8Array): Promise<void> => {
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
  };
  const part = new Uint8Array(EXPORT_PART_BYTES);
  let filled = 0;
  for await (const chunk of body) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const taken = Math.min(chunk.byteLength - offset, EXPORT_PART_BYTES - filled);
      part.set(chunk.subarray(offset, offset + taken), filled);
      filled += taken;
      offset += taken;
      if (filled < EXPORT_PART_BYTES) continue;
      await uploadPart(part);
      filled = 0;
    }
  }
  if (filled > 0 || parts.length === 0) await uploadPart(part.subarray(0, filled));
  await upload.complete(parts);
};

const listKeys = async (bucket: R2Bucket, prefix: string): Promise<R2Object[]> => {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
};

const listFolders = async (bucket: R2Bucket, prefix: string): Promise<string[]> => {
  const folders: string[] = [];
  let cursor: string | undefined;
  do {
    const options = { prefix, delimiter: "/" };
    const page = await bucket.list(cursor === undefined ? options : { ...options, cursor });
    folders.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return folders;
};

export const r2Storage = (bucket: R2Bucket, origin: string): StorageService => {
  const referenceOf = (key: string, content: Uint8Array): StorageReference => ({
    uri: buildStorageUri(StorageType.S3, STORAGE_URI_BUCKET_LABEL, key),
    storageType: StorageType.S3,
    storageLocation: STORAGE_URI_BUCKET_LABEL,
    storageKey: key,
    sizeBytes: content.byteLength,
    checksumSha256: computeChecksum(Buffer.from(content)),
    contentEncoding: ContentEncoding.None,
  });

  const put = async (
    key: string,
    content: Uint8Array,
    options: R2PutOptions = {},
  ): Promise<StorageReference> => {
    await bucket.put(key, content, options);
    return referenceOf(key, content);
  };

  const read = async (key: string): Promise<Buffer | null> => {
    const object = await bucket.get(key);
    if (object === null) return null;
    return Buffer.from(await object.arrayBuffer());
  };

  const readExisting = async (key: string): Promise<Buffer> => {
    const content = await read(key);
    if (content === null) throw new Error(`object ${key} not found in ${STORAGE_URI_BUCKET_LABEL}`);
    return content;
  };

  const deletePrefix = async (keyPrefix: string): Promise<void> => {
    let cursor: string | undefined;
    do {
      const page = await bucket.list(
        cursor === undefined ? { prefix: keyPrefix } : { prefix: keyPrefix, cursor },
      );
      if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  };

  return {
    storeMessageBody: ({ accountConfigId, accountId, messageId, content }) =>
      put(buildMessageBodyKey(accountConfigId, accountId, messageId), content),
    storeBodyPart: ({ accountConfigId, accountId, messageId, partPath, content, contentType }) =>
      put(
        buildBodyPartKey(accountConfigId, accountId, messageId, partPath),
        content,
        contentType === undefined ? {} : { httpMetadata: { contentType } },
      ),
    bodyPartExists: async (accountConfigId, accountId, messageId, partPath) =>
      (await bucket.head(buildBodyPartKey(accountConfigId, accountId, messageId, partPath))) !==
      null,
    retrieveBodyPart: (accountConfigId, accountId, messageId, partPath) =>
      read(buildBodyPartKey(accountConfigId, accountId, messageId, partPath)),
    storeOutboxAttachment: ({
      accountConfigId,
      accountId,
      outboxMessageId,
      outboxAttachmentId,
      content,
    }) =>
      put(
        buildOutboxAttachmentKey(accountConfigId, accountId, outboxMessageId, outboxAttachmentId),
        content,
      ),
    listOutboxAttachments: async (accountConfigId, accountId, outboxMessageId) => {
      const prefix = buildOutboxAttachmentPrefix(accountConfigId, accountId, outboxMessageId);
      return (await listKeys(bucket, prefix)).map((object) => ({
        outboxAttachmentId: object.key.slice(prefix.length),
        key: object.key,
        sizeBytes: object.size,
      }));
    },
    deleteOutboxAttachments: (accountConfigId, accountId, outboxMessageId) =>
      deletePrefix(buildOutboxAttachmentPrefix(accountConfigId, accountId, outboxMessageId)),
    deletePrefix,
    listOutboxDraftsWithAttachments: async (accountConfigId, accountId) => {
      const prefix = `accounts/${accountConfigId}/${accountId}/outbox/`;
      return (await listFolders(bucket, prefix)).map((folder) =>
        folder.slice(prefix.length).replace(/\/$/, ""),
      );
    },
    deleteOutboxAttachment: (accountConfigId, accountId, outboxMessageId, outboxAttachmentId) =>
      bucket.delete(
        buildOutboxAttachmentKey(accountConfigId, accountId, outboxMessageId, outboxAttachmentId),
      ),
    statOutboxAttachment: async (
      accountConfigId,
      accountId,
      outboxMessageId,
      outboxAttachmentId,
    ) => {
      const head = await bucket.head(
        buildOutboxAttachmentKey(accountConfigId, accountId, outboxMessageId, outboxAttachmentId),
      );
      return head === null ? null : { sizeBytes: head.size };
    },
    retrieveOutboxAttachment: (accountConfigId, accountId, outboxMessageId, outboxAttachmentId) =>
      read(
        buildOutboxAttachmentKey(accountConfigId, accountId, outboxMessageId, outboxAttachmentId),
      ),
    createOutboxAttachmentUploadUrl: async ({
      accountConfigId,
      accountId,
      outboxMessageId,
      outboxAttachmentId,
    }) => ({
      uploadUrl: `${origin}${UPLOAD_ROUTE_PREFIX}${buildOutboxAttachmentKey(accountConfigId, accountId, outboxMessageId, outboxAttachmentId)}`,
    }),
    storeDeduplicated: ({ accountConfigId, accountId, content }) =>
      put(buildDeduplicatedKey(accountConfigId, accountId, computeChecksum(content)), content),
    storeParsedBody: ({ accountConfigId, accountId, messageId, parsed }) =>
      put(
        buildParsedBodyKey(accountConfigId, accountId, messageId),
        Buffer.from(JSON.stringify(parsed), "utf8"),
      ),
    retrieveParsedBody: async (
      accountConfigId,
      accountId,
      messageId,
    ): Promise<ParsedBody | null> => {
      const content = await read(buildParsedBodyKey(accountConfigId, accountId, messageId));
      if (content === null) return null;
      return parsedBodySchema.parse(JSON.parse(content.toString("utf8")));
    },
    retrieveMessageBody: (accountConfigId, accountId, messageId) =>
      read(buildMessageBodyKey(accountConfigId, accountId, messageId)),
    retrieveMessageBodyStream: async (accountConfigId, accountId, messageId) => {
      const content = await read(buildMessageBodyKey(accountConfigId, accountId, messageId));
      return content === null ? null : Readable.from([content]);
    },
    retrieve: (uri) => readExisting(parseStorageUri(uri).storageKey),
    exists: async (uri) => (await bucket.head(parseStorageUri(uri).storageKey)) !== null,
    delete: (uri) => bucket.delete(parseStorageUri(uri).storageKey),
    storeExportArchiveStream: async (accountConfigId, exportRequestId, body) => {
      const key = buildExportArchiveKey(accountConfigId, exportRequestId);
      await uploadInParts(bucket, key, body);
      return key;
    },
    deleteExportArchive: (accountConfigId, exportRequestId) =>
      bucket.delete(buildExportArchiveKey(accountConfigId, exportRequestId)),
    getPresignedDownloadUrl: async (key) => `${origin}${CONTENT_PREFIX}${key}`,
  };
};
