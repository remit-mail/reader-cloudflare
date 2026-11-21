import {
  CLASSIFICATION_PRESETS,
  isClassificationPresetId,
} from "@remit/data-ports/classification-presets";
import type { ClassificationInput } from "./operator-settings-contract";

export interface StoredTarget {
  readonly presetId: string;
  readonly baseUrl: string;
}

export type KeyChoice<T extends StoredTarget> =
  | { readonly kind: "Keep"; readonly stored: T }
  | { readonly kind: "Enter"; readonly apiKey: string }
  | { readonly kind: "Refused"; readonly message: string };

const presetOf = (presetId: string) =>
  isClassificationPresetId(presetId) ? CLASSIFICATION_PRESETS[presetId] : undefined;

const resolvedBaseUrl = (input: ClassificationInput): string =>
  input.baseUrl !== "" ? input.baseUrl : (presetOf(input.presetId)?.defaultBaseUrl ?? "");

export const keyChoiceOf = <T extends StoredTarget>(
  stored: T | undefined,
  input: ClassificationInput,
): KeyChoice<T> => {
  if (input.apiKey !== "" || stored === undefined || presetOf(input.presetId)?.needsKey === false) {
    return { kind: "Enter", apiKey: input.apiKey };
  }
  if (stored.presetId === input.presetId && stored.baseUrl === resolvedBaseUrl(input)) {
    return { kind: "Keep", stored };
  }
  return { kind: "Refused", message: "Enter the API key again: the preset or base URL changed." };
};

export const isHttpsUrl = (value: string): boolean =>
  URL.canParse(value) && new URL(value).protocol === "https:";
