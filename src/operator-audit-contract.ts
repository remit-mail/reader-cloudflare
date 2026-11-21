export type OperatorAuditEvent = "ClassificationSet" | "ClassificationCleared" | "SettingsUpdated";

export interface OperatorAuditRecord {
  readonly actorEmail: string;
  readonly targetEmail: string;
  readonly address: string;
  readonly event: OperatorAuditEvent;
  readonly outcome: "Succeeded" | "Refused";
  readonly clientId: string;
}

export type PersonEmail =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly refusal: "not_found" };

export interface LoginOperatorService {
  isDisabled(email: string): Promise<boolean>;
  isOperator(email: string): Promise<boolean>;
  personEmail(callerEmail: string, userId: string): Promise<PersonEmail>;
  writeAudit(record: OperatorAuditRecord): Promise<void>;
}
