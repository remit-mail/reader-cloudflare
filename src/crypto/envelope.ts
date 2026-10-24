import { and, eq } from "drizzle-orm";
import { type AppDb, openAppDb } from "../db/client";
import { type credentials, tenantKeys } from "../db/schema";
import type { Env } from "../env";

const MASTER_KEY_VERSION = 1;
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const AES_GCM = "AES-GCM";

type TenantKeyRow = typeof tenantKeys.$inferSelect;

export type CredentialRow = typeof credentials.$inferSelect;

export interface SealedSecret {
  readonly keyVersion: number;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
}

export type DecryptResult =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly reason: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isCryptoKey = (value: CryptoKey | CryptoKeyPair): value is CryptoKey =>
  value instanceof CryptoKey;

const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0));

const randomIv = (): Uint8Array => crypto.getRandomValues(new Uint8Array(IV_BYTES));

const wrapContext = (tenantId: string, keyVersion: number): Uint8Array =>
  encoder.encode(`tenant_key:${tenantId}:${keyVersion}`);

const secretContext = (tenantId: string): Uint8Array => encoder.encode(`credential:${tenantId}`);

const importMasterKey = async (env: Env): Promise<CryptoKey> => {
  const raw = decodeBase64(await env.MASTER_KEY.get());
  if (raw.byteLength !== MASTER_KEY_BYTES) {
    throw new Error(`MASTER_KEY must decode to ${MASTER_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, AES_GCM, false, ["wrapKey", "unwrapKey"]);
};

const generateDataKey = async (): Promise<CryptoKey> => {
  const key = await crypto.subtle.generateKey({ name: AES_GCM, length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  if (!isCryptoKey(key)) throw new Error("AES-GCM generateKey returned a key pair");
  return key;
};

const wrapNewDataKey = async (masterKey: CryptoKey, tenantId: string): Promise<TenantKeyRow> => {
  const iv = randomIv();
  const wrapped = await crypto.subtle.wrapKey("raw", await generateDataKey(), masterKey, {
    name: AES_GCM,
    iv,
    additionalData: wrapContext(tenantId, MASTER_KEY_VERSION),
  });
  return {
    tenantId,
    keyVersion: MASTER_KEY_VERSION,
    wrappedKey: new Uint8Array(wrapped),
    iv,
  };
};

const unwrapDataKey = (masterKey: CryptoKey, row: TenantKeyRow): Promise<CryptoKey> =>
  crypto.subtle.unwrapKey(
    "raw",
    row.wrappedKey,
    masterKey,
    { name: AES_GCM, iv: row.iv, additionalData: wrapContext(row.tenantId, row.keyVersion) },
    AES_GCM,
    false,
    ["encrypt", "decrypt"],
  );

const selectTenantKey = (db: AppDb, tenantId: string, keyVersion: number) =>
  db
    .select()
    .from(tenantKeys)
    .where(and(eq(tenantKeys.tenantId, tenantId), eq(tenantKeys.keyVersion, keyVersion)));

const ensureTenantKey = async (
  db: AppDb,
  masterKey: CryptoKey,
  tenantId: string,
): Promise<TenantKeyRow> => {
  const [existing] = await selectTenantKey(db, tenantId, MASTER_KEY_VERSION);
  if (existing !== undefined) return existing;
  const candidate = await wrapNewDataKey(masterKey, tenantId);
  const [, [stored]] = await db.batch([
    db.insert(tenantKeys).values(candidate).onConflictDoNothing(),
    selectTenantKey(db, tenantId, MASTER_KEY_VERSION),
  ]);
  if (stored === undefined) throw new Error("tenant key missing after insert");
  return stored;
};

export const encryptSecret = async (
  env: Env,
  tenantId: string,
  plaintext: string,
): Promise<SealedSecret> => {
  const masterKey = await importMasterKey(env);
  const tenantKey = await ensureTenantKey(openAppDb(env.DB), masterKey, tenantId);
  const dataKey = await unwrapDataKey(masterKey, tenantKey);
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv, additionalData: secretContext(tenantId) },
    dataKey,
    encoder.encode(plaintext),
  );
  return { keyVersion: tenantKey.keyVersion, ciphertext: new Uint8Array(ciphertext), iv };
};

export const decryptSecret = async (
  env: Env,
  tenantId: string,
  credential: CredentialRow,
): Promise<DecryptResult> => {
  if (credential.keyVersion !== MASTER_KEY_VERSION) {
    return { ok: false, reason: `no master key for key_version ${credential.keyVersion}` };
  }
  const [tenantKey] = await selectTenantKey(openAppDb(env.DB), tenantId, credential.keyVersion);
  if (tenantKey === undefined) return { ok: false, reason: "tenant key not found" };
  const dataKey = await unwrapDataKey(await importMasterKey(env), tenantKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: AES_GCM, iv: credential.iv, additionalData: secretContext(tenantId) },
    dataKey,
    credential.ciphertext,
  );
  return { ok: true, plaintext: decoder.decode(plaintext) };
};
