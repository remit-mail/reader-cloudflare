export type OperatorAuditEvent = "ClassificationSet" | "ClassificationCleared" | "SettingsUpdated";

export interface OperatorAuditRecord {
  readonly actorEmail: string;
  readonly targetEmail: string;
  readonly address: string;
  readonly event: OperatorAuditEvent;
  readonly outcome: "Succeeded" | "Refused";
  readonly clientId: string;
}

export interface LoginOperatorService {
  isDisabled(email: string): Promise<boolean>;
  isOperator(email: string): Promise<boolean>;
  writeAudit(record: OperatorAuditRecord): Promise<void>;
}
