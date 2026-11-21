export type OperatorAuditEvent = "ClassificationSet" | "ClassificationCleared" | "SettingsUpdated";

export interface OperatorAuditRecord {
  readonly actor: string;
  readonly email: string;
  readonly address: string;
  readonly event: OperatorAuditEvent;
  readonly outcome: "Succeeded" | "Refused";
  readonly clientId: string;
}

export interface LoginOperatorService {
  isOperator(userId: string): Promise<boolean>;
  writeAudit(record: OperatorAuditRecord): Promise<void>;
}
