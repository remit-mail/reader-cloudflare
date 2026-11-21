import { WorkerEntrypoint } from "cloudflare:workers";
import { parseClassificationDefault } from "@remit/backend/classification-default";
import {
  CLASSIFICATION_PRESETS,
  type ClassificationDeploymentDefault,
} from "@remit/data-ports/classification-presets";
import { eq, sql } from "drizzle-orm";
import { openClassificationKey, type SealedSecret, sealClassificationKey } from "./crypto/envelope";
import { openAppDb } from "./db/client";
import { classificationDefaults } from "./db/schema";
import type { Env } from "./env";
import type {
  ClassificationInput,
  ClassificationPresetOption,
  ClassificationView,
  ClassificationWrite,
  OperatorSettingsService,
} from "./operator-settings-contract";

const DEPLOYMENT = "Deployment";

type ClassificationRow = typeof classificationDefaults.$inferSelect;

const PRESETS: readonly ClassificationPresetOption[] = Object.values(CLASSIFICATION_PRESETS).map(
  (preset) => ({
    presetId: preset.presetId,
    label: preset.label,
    needsKey: preset.needsKey,
    defaultBaseUrl: preset.defaultBaseUrl ?? null,
    defaultModel: preset.defaultModel,
  }),
);

const rowOf = async (env: Env): Promise<ClassificationRow | undefined> => {
  const [row] = await openAppDb(env.DB)
    .select()
    .from(classificationDefaults)
    .where(eq(classificationDefaults.classificationDefaultId, DEPLOYMENT));
  return row;
};

const secretOf = (row: ClassificationRow): SealedSecret => ({
  sealed: row.apiKeySealed,
  iv: row.iv,
  keyVersion: row.keyVersion,
});

export const classificationDefaultOf = async (
  env: Env,
): Promise<ClassificationDeploymentDefault> => {
  const row = await rowOf(env);
  if (row === undefined) return { state: "None" };
  const parsed = parseClassificationDefault({
    presetId: row.presetId,
    model: row.model,
    baseUrl: row.baseUrl,
    apiKey: await openClassificationKey(env, secretOf(row)),
    enabled: row.enabled,
    dailyLimit: row.dailyLimit,
  });
  if (!parsed.ok) throw new Error(`the stored classifier default is invalid: ${parsed.message}`);
  return parsed.value;
};

const viewOf = async (
  env: Env,
  row: ClassificationRow | undefined,
): Promise<ClassificationView> => {
  if (row === undefined) return { state: "None", presets: PRESETS };
  return {
    state: "Configured",
    presets: PRESETS,
    presetId: row.presetId,
    model: row.model,
    baseUrl: row.baseUrl,
    dailyLimit: row.dailyLimit,
    enabled: row.enabled,
    hasKey: (await openClassificationKey(env, secretOf(row))) !== "",
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
};

const isHttpUrl = (value: string): boolean =>
  URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);

const refused = (message: string): ClassificationWrite => ({ ok: false, message });

export const writeClassification = async (
  env: Env,
  input: ClassificationInput,
  operatorEmail: string,
): Promise<ClassificationWrite> => {
  if (input.baseUrl !== "" && !isHttpUrl(input.baseUrl)) {
    return refused(`baseUrl=${input.baseUrl} must be an http or https URL.`);
  }
  const existing = await rowOf(env);
  const kept = input.apiKey === "" && existing !== undefined ? secretOf(existing) : null;
  const apiKey = kept === null ? input.apiKey : await openClassificationKey(env, kept);
  const parsed = parseClassificationDefault({ ...input, apiKey });
  if (!parsed.ok) return refused(parsed.message);
  if (parsed.value.state !== "Configured") return refused("The classifier default is not set.");
  const value = parsed.value;
  if (!isHttpUrl(value.baseUrl)) {
    return refused(`baseUrl=${value.baseUrl} must be an http or https URL.`);
  }
  const secret = kept ?? (await sealClassificationKey(env, apiKey));
  const settings = {
    presetId: value.presetId,
    model: value.model,
    baseUrl: value.baseUrl,
    apiKeySealed: secret.sealed,
    iv: secret.iv,
    keyVersion: secret.keyVersion,
    dailyLimit: value.dailyLimit,
    enabled: value.enabled,
    updatedAt: Date.now(),
    updatedBy: operatorEmail,
  };
  const [stored] = await openAppDb(env.DB)
    .insert(classificationDefaults)
    .values({ classificationDefaultId: DEPLOYMENT, version: 1, ...settings })
    .onConflictDoUpdate({
      target: classificationDefaults.classificationDefaultId,
      set: { ...settings, version: sql`${classificationDefaults.version} + 1` },
    })
    .returning();
  if (stored === undefined) throw new Error("classification_default row missing after upsert");
  return { ok: true, view: await viewOf(env, stored) };
};

export class OperatorSettings extends WorkerEntrypoint<Env> implements OperatorSettingsService {
  async readClassification(): Promise<ClassificationView> {
    return viewOf(this.env, await rowOf(this.env));
  }

  writeClassification(
    input: ClassificationInput,
    operatorEmail: string,
  ): Promise<ClassificationWrite> {
    return writeClassification(this.env, input, operatorEmail);
  }
}
