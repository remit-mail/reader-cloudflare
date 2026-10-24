import type { BodyPartResponse, MediaType } from "@remit/api-openapi-types";
import type { Attachment, Email } from "postal-mime";

export interface MessagePart {
  readonly partPath: string;
  readonly mediaType: MediaType;
  readonly mediaSubtype: string;
  readonly disposition: NonNullable<BodyPartResponse["disposition"]>;
  readonly filename: string | null;
  readonly contentId: string | null;
  readonly contentType: string;
  readonly content: Uint8Array;
}

const MEDIA_TYPES: readonly MediaType[] = [
  "TEXT",
  "IMAGE",
  "AUDIO",
  "VIDEO",
  "APPLICATION",
  "MULTIPART",
  "MESSAGE",
];

const encoder = new TextEncoder();

const toMediaType = (value: string): MediaType =>
  MEDIA_TYPES.find((type) => type === value.toUpperCase()) ?? "APPLICATION";

const toBytes = (content: Attachment["content"]): Uint8Array => {
  if (typeof content === "string") return encoder.encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
};

const textPart = (partPath: string, subtype: string, text: string): MessagePart => ({
  partPath,
  mediaType: "TEXT",
  mediaSubtype: subtype.toUpperCase(),
  disposition: "inline",
  filename: null,
  contentId: null,
  contentType: `text/${subtype}; charset=utf-8`,
  content: encoder.encode(text),
});

const attachmentPart = (attachment: Attachment, index: number): MessagePart => {
  const [type = "application", subtype = "octet-stream"] = attachment.mimeType.split("/");
  const inline = attachment.disposition === "inline" || attachment.related === true;
  return {
    partPath: `attachment-${index}`,
    mediaType: toMediaType(type),
    mediaSubtype: subtype.toUpperCase(),
    disposition: inline ? "inline" : "attachment",
    filename: attachment.filename,
    contentId: attachment.contentId ?? null,
    contentType: attachment.mimeType,
    content: toBytes(attachment.content),
  };
};

export const messageParts = (email: Email): readonly MessagePart[] => [
  ...(email.html === undefined ? [] : [textPart("html", "html", email.html)]),
  ...(email.text === undefined ? [] : [textPart("text", "plain", email.text)]),
  ...email.attachments.map(attachmentPart),
];
