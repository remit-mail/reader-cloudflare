import PostalMime, { type Address, type Email, type Mailbox, type RawEmail } from "postal-mime";
import type { AddressInput } from "./types";

export interface ParsedBody {
  readonly text: string;
  readonly html: string;
  readonly attachments: readonly {
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
  }[];
}

export const parseEmail = (raw: RawEmail): Promise<Email> =>
  PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });

const mailboxes = (addresses: readonly Address[] | undefined): readonly Mailbox[] =>
  (addresses ?? []).flatMap((address): Mailbox[] =>
    address.group === undefined ? [address] : address.group,
  );

export const toAddressInputs = (addresses: readonly Address[] | undefined): AddressInput[] =>
  mailboxes(addresses).map((mailbox) => ({
    name: mailbox.name === "" ? null : mailbox.name,
    address: mailbox.address,
  }));

const sizeOf = (content: ArrayBuffer | Uint8Array | string): number =>
  typeof content === "string" ? content.length : content.byteLength;

export const toBody = (email: Email): ParsedBody => ({
  text: email.text ?? "",
  html: email.html ?? "",
  attachments: email.attachments.map((attachment) => ({
    filename: attachment.filename ?? "",
    mimeType: attachment.mimeType,
    size: sizeOf(attachment.content),
  })),
});
