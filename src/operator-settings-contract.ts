export interface ClassificationPresetOption {
  readonly presetId: string;
  readonly label: string;
}

export type ClassificationView =
  | { readonly state: "None"; readonly presets: readonly ClassificationPresetOption[] }
  | {
      readonly state: "Configured";
      readonly presets: readonly ClassificationPresetOption[];
      readonly presetId: string;
      readonly model: string;
      readonly baseUrl: string;
      readonly dailyLimit: number;
      readonly enabled: boolean;
      readonly hasKey: boolean;
      readonly version: number;
      readonly updatedAt: number;
      readonly updatedBy: string;
    };

export interface ClassificationInput {
  readonly presetId: ClassificationPresetId;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly dailyLimit: number;
  readonly enabled: boolean;
}

export type ClassificationWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface OperatorSettingsService {
  readClassification(): Promise<ClassificationView>;
  writeClassification(
    input: ClassificationInput,
    operatorEmail: string,
  ): Promise<ClassificationWrite>;
  clearClassification(): Promise<void>;
  readTenantClassifications(
    operatorUserId: string,
    operatorEmail: string,
  ): Promise<readonly TenantClassification[]>;
  writeTenantClassification(
    userId: string,
    input: ClassificationInput,
    operatorUserId: string,
    operatorEmail: string,
  ): Promise<ClassificationWrite>;
  clearTenantClassification(
    userId: string,
    operatorUserId: string,
    operatorEmail: string,
  ): Promise<void>;
}

import type { ClassificationPresetId, UserSettingsResponse } from "@remit/api-openapi-types";

export interface TenantClassification {
  readonly userId: string;
  readonly settings: UserSettingsResponse;
}
