import { classificationDefaultFromEnv } from "@remit/backend/classification-default";
import type { ClassificationDeploymentDefault } from "@remit/data-ports/classification-presets";
import type { Env } from "./env";

const SNAPSHOT_MS = 60_000;

export interface LastKnownSnapshot<T> {
  get(): Promise<T>;
  invalidate(): void;
}

export const lastKnownSnapshot = <T>(
  read: () => Promise<T>,
  now: () => number = Date.now,
): LastKnownSnapshot<T> => {
  let snapshot: { readonly value: T } | undefined;
  let expiresAt = 0;
  return {
    get: async () => {
      const at = now();
      if (snapshot !== undefined && at < expiresAt) return snapshot.value;
      try {
        snapshot = { value: await read() };
      } catch (error) {
        if (snapshot === undefined) throw error;
      }
      expiresAt = at + SNAPSHOT_MS;
      return snapshot.value;
    },
    invalidate: () => {
      expiresAt = 0;
    },
  };
};

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
  const snapshot = lastKnownSnapshot(async () => (await readOverride()) ?? readDeployment(), now);
  return snapshot.get;
};
