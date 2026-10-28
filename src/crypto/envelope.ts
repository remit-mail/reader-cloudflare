import { deriveAccountConfigId } from "@remit/data-ports/id";
import {
  createCachedDataKeyProvider,
  createSecretsService,
  type DataKeyProvider,
  type SecretsService,
} from "@remit/secrets-service";
import { and, eq } from "drizzle-orm";
import { type AppDb, openAppDb } from "../db/client";
import { tenantAccountConfigs, tenantKeys } from "../db/schema";
import type { Env } from "../env";

const MASTER_KEY_VERSION = 1;
const MASTER_KEY_BYTES = 32;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const AES_GCM = "AES-GCM";

type TenantKeyRow = typeof tenantKeys.$inferSelect;

const encoder = new TextEncoder();

const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0));

const wrapContext = (tenantId: string, keyVersion: number): Uint8Array =>
  encoder.encode(`tenant_key:${tenantId}:${keyVersion}`);

const importMasterKey = async (env: Env): Promise<CryptoKey> => {
  const raw = decodeBase64(await env.MASTER_KEY.get());
  if (raw.byteLength !== MASTER_KEY_BYTES) {
    throw new Error(`MASTER_KEY must decode to ${MASTER_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, AES_GCM, false, ["encrypt", "decrypt"]);
};

const wrapNewDataKey = async (masterKey: CryptoKey, tenantId: string): Promise<TenantKeyRow> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.encrypt(
    { name: AES_GCM, iv, additionalData: wrapContext(tenantId, MASTER_KEY_VERSION) },
    masterKey,
    crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES)),
  );
  return {
    tenantId,
    keyVersion: MASTER_KEY_VERSION,
    wrappedKey: new Uint8Array(wrapped),
    iv,
  };
};

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
  const [, , [stored]] = await db.batch([
    db.insert(tenantKeys).values(candidate).onConflictDoNothing(),
    db
      .insert(tenantAccountConfigs)
      .values({ accountConfigId: deriveAccountConfigId(tenantId), tenantId })
      .onConflictDoNothing(),
    selectTenantKey(db, tenantId, MASTER_KEY_VERSION),
  ]);
  if (stored === undefined) throw new Error("tenant key missing after insert");
  return stored;
};

const sealedKeyOf = (row: TenantKeyRow): Uint8Array => {
  const sealed = new Uint8Array(1 + IV_BYTES + row.wrappedKey.byteLength);
  sealed[0] = row.keyVersion;
  sealed.set(row.iv, 1);
  sealed.set(row.wrappedKey, 1 + IV_BYTES);
  return sealed;
};

const openDataKey = async (
  masterKey: CryptoKey,
  tenantId: string,
  sealed: Uint8Array,
): Promise<Uint8Array> => {
  const keyVersion = sealed[0];
  if (keyVersion !== MASTER_KEY_VERSION) {
    throw new Error(`no master key for key_version ${keyVersion ?? "missing"}`);
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: AES_GCM,
      iv: sealed.slice(1, 1 + IV_BYTES),
      additionalData: wrapContext(tenantId, keyVersion),
    },
    masterKey,
    sealed.slice(1 + IV_BYTES),
  );
  return new Uint8Array(plaintext);
};

export const bootstrapTenant = async (env: Env, tenantId: string): Promise<void> => {
  await ensureTenantKey(openAppDb(env.DB), await importMasterKey(env), tenantId);
};

const tenantDataKeys = (env: Env, tenantId: string): DataKeyProvider => ({
  generateDataKey: async () => {
    const masterKey = await importMasterKey(env);
    const encrypted = sealedKeyOf(await ensureTenantKey(openAppDb(env.DB), masterKey, tenantId));
    return { plaintext: await openDataKey(masterKey, tenantId, encrypted), encrypted };
  },
  decryptDataKey: async (encrypted) => openDataKey(await importMasterKey(env), tenantId, encrypted),
});

export const tenantSecrets = (env: Env, tenantId: string): SecretsService =>
  createSecretsService(createCachedDataKeyProvider(tenantDataKeys(env, tenantId)));
