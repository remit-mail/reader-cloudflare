import { WorkerEntrypoint } from "cloudflare:workers";
import { parseClassificationDefault } from "@remit/backend/classification-default";
import type { ClassificationDefaultStore } from "@remit/backend/create-remit-client";
import {
  CLASSIFICATION_PRESETS,
  type ClassificationDeploymentDefault,
} from "@remit/data-ports/classification-presets";
import { eq, sql } from "drizzle-orm";
import {
  classificationDefaultFromDeployment,
  type LastKnownSnapshot,
  lastKnownSnapshot,
} from "./classification-default";
import { isHttpsUrl, keyChoiceOf } from "./classification-key";
import {
  openClassificationKey,
  type SealedSecret,
  sealClassificationKey,
  sealsEmptyKey,
} from "./crypto/envelope";
import { openAppDb } from "./db/client";
import { classificationDefaults, tenantKeys } from "./db/schema";
import type { Env } from "./env";
import type {
  ClassificationInput,
  ClassificationPresetOption,
  ClassificationView,
  ClassificationWrite,
  OperatorSettingsService,
  TenantClassification,
} from "./operator-settings-contract";
import { tenantMail } from "./stubs";

const DEPLOYMENT = "Deployment";

type ClassificationRow = typeof classificationDefaults.$inferSelect;
type ClassificationSetting = Awaited<ReturnType<ClassificationDefaultStore["get"]>>;

const defaultSnapshots = new WeakMap<Env, LastKnownSnapshot<ClassificationSetting>>();

const PRESETS: readonly ClassificationPresetOption[] = Object.values(CLASSIFICATION_PRESETS).map(
  ({ presetId, label }) => ({ presetId, label }),
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
): Promise<ClassificationDeploymentDefault | undefined> => {
  const row = await rowOf(env);
  if (row === undefined) return undefined;
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

const viewOf = (row: ClassificationRow | undefined): ClassificationView => {
  if (row === undefined) return { state: "None", presets: PRESETS };
  return {
    state: "Configured",
    presets: PRESETS,
    presetId: row.presetId,
    model: row.model,
    baseUrl: row.baseUrl,
    dailyLimit: row.dailyLimit,
    enabled: row.enabled,
    hasKey: !sealsEmptyKey(secretOf(row)),
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
};

const refused = (message: string): ClassificationWrite => ({ ok: false, message });

const tenantIds = async (env: Env): Promise<readonly string[]> => {
  const rows = await openAppDb(env.DB)
    .selectDistinct({ tenantId: tenantKeys.tenantId })
    .from(tenantKeys);
  return rows.map((row) => row.tenantId);
};

const readTenantClassification = async (
  env: Env,
  userId: string,
): Promise<TenantClassification> => {
  return { userId, settings: await tenantMail(env, userId).readUserSettings(userId) };
};

export const writeClassification = async (
  env: Env,
  input: ClassificationInput,
  operatorEmail: string,
): Promise<ClassificationWrite> => {
  const choice = keyChoiceOf(await rowOf(env), input);
  if (choice.kind === "Refused") return refused(choice.message);
  const kept = choice.kind === "Keep" ? secretOf(choice.stored) : null;
  const apiKey = kept === null ? input.apiKey : await openClassificationKey(env, kept);
  const parsed = parseClassificationDefault({ ...input, apiKey });
  if (!parsed.ok) return refused(parsed.message);
  if (parsed.value.state !== "Configured") return refused("The classifier default is not set.");
  const value = parsed.value;
  if (!isHttpsUrl(value.baseUrl)) return refused(`baseUrl=${value.baseUrl} must be an https URL.`);
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
  await openAppDb(env.DB)
    .insert(classificationDefaults)
    .values({ classificationDefaultId: DEPLOYMENT, version: 1, ...settings })
    .onConflictDoUpdate({
      target: classificationDefaults.classificationDefaultId,
      set: { ...settings, version: sql`${classificationDefaults.version} + 1` },
    });
  return { ok: true };
};

export const clearClassification = async (env: Env): Promise<void> => {
  await openAppDb(env.DB)
    .delete(classificationDefaults)
    .where(eq(classificationDefaults.classificationDefaultId, DEPLOYMENT));
};

export const classificationDefaultStore = (
  env: Env,
  operatorEmail: string,
): ClassificationDefaultStore => {
  let snapshot = defaultSnapshots.get(env);
  if (snapshot === undefined) {
    snapshot = lastKnownSnapshot(async () => {
      const override = await classificationDefaultOf(env);
      return override === undefined
        ? { value: await classificationDefaultFromDeployment(env), source: "Config" }
        : { value: override, source: "Operator" };
    });
    defaultSnapshots.set(env, snapshot);
  }
  return {
    get: snapshot.get,
    put: async (value) => {
      const written = await writeClassification(env, value, operatorEmail);
      if (!written.ok) throw new Error(written.message);
      snapshot.invalidate();
    },
    delete: async () => {
      await clearClassification(env);
      snapshot.invalidate();
    },
  };
};

export class OperatorSettings extends WorkerEntrypoint<Env> implements OperatorSettingsService {
  async readClassification(): Promise<ClassificationView> {
    return viewOf(await rowOf(this.env));
  }

  writeClassification(
    input: ClassificationInput,
    operatorEmail: string,
  ): Promise<ClassificationWrite> {
    return writeClassification(this.env, input, operatorEmail);
  }

  clearClassification(): Promise<void> {
    return clearClassification(this.env);
  }

  listTenantIds(): Promise<readonly string[]> {
    return tenantIds(this.env);
  }

  readTenantClassification(userId: string): Promise<TenantClassification> {
    return readTenantClassification(this.env, userId);
  }

  async writeTenantClassification(
    userId: string,
    input: ClassificationInput,
  ): Promise<ClassificationWrite> {
    const answer = await tenantMail(this.env, userId).updateUserSettings(userId, {
      classificationPresetId: input.presetId,
      classificationModel: input.model,
      classificationBaseUrl: input.baseUrl,
      classificationApiKey: input.apiKey,
      classificationDailyLimit: input.dailyLimit,
      classificationEnabled: input.enabled,
    });
    return answer.ok ? { ok: true } : refused(answer.error.message);
  }

  async clearTenantClassification(userId: string): Promise<void> {
    await tenantMail(this.env, userId).clearClassificationProvider(userId);
  }
}
