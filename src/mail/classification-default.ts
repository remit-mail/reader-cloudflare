import {
  CLASSIFICATION_PRESETS,
  type ClassificationDeploymentDefault,
  DEFAULT_CLASSIFICATION_DAILY_LIMIT,
  isClassificationPresetId,
} from "@remit/data-ports/classification-presets";
import type { Env } from "../env";

export const classificationDefaultOf = async (
  env: Pick<Env, "CLASSIFICATION_DEFAULT_PRESET" | "CLASSIFICATION_DEFAULT_API_KEY">,
): Promise<ClassificationDeploymentDefault> => {
  const presetId = env.CLASSIFICATION_DEFAULT_PRESET;
  const apiKey = env.CLASSIFICATION_DEFAULT_API_KEY;
  if (presetId === undefined || apiKey === undefined) return { state: "None" };
  if (!isClassificationPresetId(presetId)) {
    throw new Error(`CLASSIFICATION_DEFAULT_PRESET ${presetId} is not a classification preset`);
  }
  const { defaultModel, defaultBaseUrl } = CLASSIFICATION_PRESETS[presetId];
  if (defaultBaseUrl === undefined) {
    throw new Error(`classification preset ${presetId} has no default base URL`);
  }
  return {
    state: "Configured",
    presetId,
    model: defaultModel,
    baseUrl: defaultBaseUrl,
    apiKey: await apiKey.get(),
    enabled: true,
    dailyLimit: DEFAULT_CLASSIFICATION_DAILY_LIMIT,
  };
};
