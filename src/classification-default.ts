import { classificationDefaultFromEnv } from "@remit/backend/classification-default";
import type { ClassificationDeploymentDefault } from "@remit/data-ports/classification-presets";
import type { Env } from "./env";

const SNAPSHOT_MS = 60_000;

export const classificationDefaultFromDeployment = async (
  env: Pick<Env, "CLASSIFICATION_DEFAULT_PRESET" | "CLASSIFICATION_DEFAULT_API_KEY">,
): Promise<ClassificationDeploymentDefault> => {
  if (env.CLASSIFICATION_DEFAULT_PRESET === undefined) return { state: "None" };
  if (env.CLASSIFICATION_DEFAULT_API_KEY === undefined) return { state: "None" };
  return classificationDefaultFromEnv({
    CLASSIFICATION_DEFAULT_PRESET: env.CLASSIFICATION_DEFAULT_PRESET,
    CLASSIFICATION_DEFAULT_API_KEY: await env.CLASSIFICATION_DEFAULT_API_KEY.get(),
    CLASSIFICATION_DEFAULT_ENABLED: "true",
  });
};

export const classificationDefaultSnapshot = (
  readOverride: () => Promise<ClassificationDeploymentDefault | undefined>,
  readDeployment: () => Promise<ClassificationDeploymentDefault>,
  now: () => number = Date.now,
): (() => Promise<ClassificationDeploymentDefault>) => {
  let value: ClassificationDeploymentDefault | undefined;
  let expiresAt = 0;
  return async () => {
    const at = now();
    if (value !== undefined && at < expiresAt) return value;
    let override: ClassificationDeploymentDefault | undefined;
    try {
      override = await readOverride();
    } catch (error) {
      if (value === undefined) throw error;
      expiresAt = at + SNAPSHOT_MS;
      return value;
    }
    value = override ?? (await readDeployment());
    expiresAt = at + SNAPSHOT_MS;
    return value;
  };
};
