import { customType } from "drizzle-orm/sqlite-core";

const base36Digits = "0123456789abcdefghijklmnopqrstuvwxyz";
const hexDigits = "0123456789abcdef";

const base36Values = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < base36Digits.length; i += 1) table[base36Digits.charCodeAt(i)] = i;
  return table;
})();

const hexValues = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < hexDigits.length; i += 1) {
    table[hexDigits.charCodeAt(i)] = i;
    table[hexDigits.toUpperCase().charCodeAt(i)] = i;
  }
  return table;
})();

const hexOctets = ((): string[] => {
  const table: string[] = [];
  for (let i = 0; i < 256; i += 1) table.push(i.toString(16).padStart(2, "0"));
  return table;
})();

const base36Scales = [1, 36, 1296, 46656, 1679616, 60466176];

function readBase36(id: string, start: number, count: number): number {
  let value = 0;
  for (let i = start; i < start + count; i += 1) {
    const code = id.charCodeAt(i);
    const digit = code < 128 ? base36Values[code] : -1;
    if (digit < 0) throw new Error(`Not a base36 uuid: ${id}`);
    value = value * 36 + digit;
  }
  return value;
}

function scaleAndAdd(limbs: Uint32Array, scale: number, addend: number): number {
  let carry = addend;
  for (let i = 7; i >= 0; i -= 1) {
    const product = limbs[i] * scale + carry;
    const low = product % 65536;
    limbs[i] = low;
    carry = (product - low) / 65536;
  }
  return carry;
}

function base36ToBytes(id: string): Uint8Array {
  if (id.length === 0 || id.length > 25) throw new Error(`Not a base36 uuid: ${id}`);
  const limbs = new Uint32Array(8);
  const head = id.length % 5;
  if (head > 0 && scaleAndAdd(limbs, base36Scales[head], readBase36(id, 0, head)) !== 0) {
    throw new Error(`base36 uuid does not fit in 128 bits: ${id}`);
  }
  for (let cursor = head; cursor < id.length; cursor += 5) {
    if (scaleAndAdd(limbs, 60466176, readBase36(id, cursor, 5)) !== 0) {
      throw new Error(`base36 uuid does not fit in 128 bits: ${id}`);
    }
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = limbs[i] >>> 8;
    bytes[i * 2 + 1] = limbs[i] & 0xff;
  }
  return bytes;
}

function bytesToBase36(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error(`Not a 16-byte uuid: ${bytes.length} bytes`);
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i += 1) limbs[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  let id = "";
  for (let chunk = 0; chunk < 5; chunk += 1) {
    let remainder = 0;
    for (let i = 0; i < 8; i += 1) {
      const current = remainder * 65536 + limbs[i];
      const quotient = Math.floor(current / 60466176);
      limbs[i] = quotient;
      remainder = current - quotient * 60466176;
    }
    let piece = "";
    for (let i = 0; i < 5; i += 1) {
      const digit = remainder % 36;
      piece = base36Digits[digit] + piece;
      remainder = (remainder - digit) / 36;
    }
    id = piece + id;
  }
  return id;
}

function uuidToBytes(uuid: string): Uint8Array {
  const bytes = new Uint8Array(16);
  let cursor = 0;
  for (let i = 0; i < 16; i += 1) {
    if (uuid.charCodeAt(cursor) === 45) cursor += 1;
    const high = readHex(uuid, cursor);
    const low = readHex(uuid, cursor + 1);
    bytes[i] = (high << 4) | low;
    cursor += 2;
  }
  if (cursor !== uuid.length) throw new Error(`Not a uuid: ${uuid}`);
  return bytes;
}

function readHex(uuid: string, index: number): number {
  const code = uuid.charCodeAt(index);
  const value = code < 128 ? hexValues[code] : -1;
  if (value < 0) throw new Error(`Not a uuid: ${uuid}`);
  return value;
}

function bytesToUuid(bytes: Uint8Array): string {
  return `${hexOctets[bytes[0]]}${hexOctets[bytes[1]]}${hexOctets[bytes[2]]}${hexOctets[bytes[3]]}-${hexOctets[bytes[4]]}${hexOctets[bytes[5]]}-${hexOctets[bytes[6]]}${hexOctets[bytes[7]]}-${hexOctets[bytes[8]]}${hexOctets[bytes[9]]}-${hexOctets[bytes[10]]}${hexOctets[bytes[11]]}${hexOctets[bytes[12]]}${hexOctets[bytes[13]]}${hexOctets[bytes[14]]}${hexOctets[bytes[15]]}`;
}

/** UUID column stored as text in the 36-character hyphenated form, reads/writes as base36 */
export const canonicalUuid = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "text",
  toDriver: (value: string): string => bytesToUuid(base36ToBytes(value)),
  fromDriver: (value: string): string => bytesToBase36(uuidToBytes(value)),
});

/** UUID column stored as text in the 25-character base36 form, reads/writes as base36 */
export const base36Uuid = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "text",
});

/** UUID column stored as a 16-byte blob, reads/writes as base36 */
export const rawUuid = customType<{
  data: string;
  driverData: Uint8Array;
}>({
  dataType: () => "blob",
  toDriver: (value: string): Uint8Array => base36ToBytes(value),
  fromDriver: (value: Uint8Array): string => bytesToBase36(value),
});

export function generateBase36Id(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToBase36(bytes);
}

export const nullableText = customType<{
  data: string | undefined;
  driverData: string | null;
}>({
  dataType: () => "text",
  fromDriver: (v) => v ?? undefined,
});

export const nullableInteger = customType<{
  data: number | undefined;
  driverData: number | null;
}>({
  dataType: () => "integer",
  fromDriver: (v) => v ?? undefined,
});

export const nullableReal = customType<{
  data: number | undefined;
  driverData: number | null;
}>({
  dataType: () => "real",
  fromDriver: (v) => v ?? undefined,
});

export const nullableBlob = customType<{
  data: Uint8Array | undefined;
  driverData: Uint8Array | null;
}>({
  dataType: () => "blob",
  fromDriver: (v) => v ?? undefined,
});
