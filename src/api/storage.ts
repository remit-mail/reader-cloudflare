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
  signStoragePath,
  UPLOAD_ROUTE_PREFIX,
  UPLOAD_URL_SIGNING_LABEL,
} from "@remit/storage-service";
import { z } from "zod";

const STORAGE_URI_BUCKET_LABEL = "reader-cloudflare-mail";
const DELETE_CHUNK = 1000;

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

const unsupported = (what: string): never => {
  throw new Error(`${what} is not available on the R2 binding`);
};

export interface UploadUrls {
  readonly origin: string;
  readonly signingSecret: () => Promise<string>;
}

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
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

export const r2Storage = (bucket: R2Bucket, uploadUrls: UploadUrls): StorageService => {
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

  const removeAll = async (keys: readonly string[]): Promise<void> => {
    for (let start = 0; start < keys.length; start += DELETE_CHUNK) {
      await bucket.delete(keys.slice(start, start + DELETE_CHUNK));
    }
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
    deleteOutboxAttachments: async (accountConfigId, accountId, outboxMessageId) => {
      const prefix = buildOutboxAttachmentPrefix(accountConfigId, accountId, outboxMessageId);
      await removeAll((await listKeys(bucket, prefix)).map((object) => object.key));
    },
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
      sizeBytes,
      expiresAt,
    }) => {
      const key = buildOutboxAttachmentKey(
        accountConfigId,
        accountId,
        outboxMessageId,
        outboxAttachmentId,
      );
      const sig = signStoragePath(
        await uploadUrls.signingSecret(),
        UPLOAD_URL_SIGNING_LABEL,
        key,
        [expiresAt, sizeBytes],
      );
      const query = new URLSearchParams({ exp: String(expiresAt), max: String(sizeBytes), sig });
      return { uploadUrl: `${uploadUrls.origin}${UPLOAD_ROUTE_PREFIX}${key}?${query.toString()}` };
    },
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
      await bucket.put(key, await collect(body));
      return key;
    },
    getPresignedDownloadUrl: async () => unsupported("a presigned download URL"),
  };
};
