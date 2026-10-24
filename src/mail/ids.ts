const REMIT_NAMESPACE = "9e89694d-214b-4d9b-99f5-214b4d9b99f5";

const encoder = new TextEncoder();

const namespaceBytes = Uint8Array.from(
  REMIT_NAMESPACE.replaceAll("-", "").match(/../g) ?? [],
  (pair) => Number.parseInt(pair, 16),
);

const versioned = (byte: number, index: number): number => {
  if (index === 6) return (byte & 0x0f) | 0x50;
  if (index === 8) return (byte & 0x3f) | 0x80;
  return byte;
};

const uuidV5Base36 = async (name: string): Promise<string> => {
  const nameBytes = encoder.encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const hex = Array.from(digest.subarray(0, 16), (byte, index) =>
    versioned(byte, index).toString(16).padStart(2, "0"),
  ).join("");
  return BigInt(`0x${hex}`).toString(36).padStart(25, "0");
};

export const deriveMailboxId = (accountId: string, path: string): Promise<string> =>
  uuidV5Base36(`mailbox:${accountId}:${path}`);

export const deriveSpecialUseId = (mailboxId: string, specialUse: string): Promise<string> =>
  uuidV5Base36(`mailboxspecialuse:${mailboxId}:${specialUse}`);

export const deriveMessageId = (
  accountId: string,
  mailboxId: string,
  uid: number,
): Promise<string> => uuidV5Base36(`mailboxmessage:${accountId}:${mailboxId}:${uid}`);

export const deriveEnvelopeId = (messageId: string): Promise<string> =>
  uuidV5Base36(`envelope:${messageId}`);

export const deriveThreadMessageId = (messageId: string): Promise<string> =>
  uuidV5Base36(`threadmessage:${messageId}`);

export const deriveFlagId = (messageId: string, flag: string): Promise<string> =>
  uuidV5Base36(`messageflag:${messageId}:${flag}`);

export const deriveAddressId = (accountConfigId: string, email: string): Promise<string> =>
  uuidV5Base36(`address:${accountConfigId}:${email.toLowerCase()}`);

export const deriveEnvelopeAddressId = (
  messageId: string,
  role: string,
  order: number,
): Promise<string> => uuidV5Base36(`envelopeaddress:${messageId}:${role}:${order}`);

export const deriveBodyPartId = (messageId: string, partPath: string): Promise<string> =>
  uuidV5Base36(`bodypart:${messageId}:${partPath}`);

export const deriveAccountSettingId = (accountConfigId: string, name: string): Promise<string> =>
  uuidV5Base36(`accountsetting:${accountConfigId}:${name}`);

export const deriveConfigImportId = (accountConfigId: string, document: string): Promise<string> =>
  uuidV5Base36(`configimport:${accountConfigId}:${document}`);
