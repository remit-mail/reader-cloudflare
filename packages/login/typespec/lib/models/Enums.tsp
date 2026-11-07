namespace Login;

enum InviteState {
  Open: "Open",
  Redeemed: "Redeemed",
  Replaced: "Replaced",
  Revoked: "Revoked",
}

enum AdminAction {
  Invite: "Invite",
  Disable: "Disable",
  Enable: "Enable",
  ResetFactors: "ResetFactors",
  SignOutEverywhere: "SignOutEverywhere",
  RotateKeys: "RotateKeys",
  RevokeKeys: "RevokeKeys",
}

enum StepUpMethod {
  Passkey: "Passkey",
  Totp: "Totp",
}

enum AdminChallengeState {
  Open: "Open",
  Used: "Used",
  Expired: "Expired",
}

enum AuditEventKind {
  InviteIssued: "InviteIssued",
  InviteRedeemed: "InviteRedeemed",
  SignIn: "SignIn",
  SecondStepRequired: "SecondStepRequired",
  Backoff: "Backoff",
  ResetRequested: "ResetRequested",
  PasswordReset: "PasswordReset",
  PasswordChanged: "PasswordChanged",
  FactorAdded: "FactorAdded",
  FactorRemoved: "FactorRemoved",
  BackupCodesRegenerated: "BackupCodesRegenerated",
  SignOut: "SignOut",
  SignOutEverywhere: "SignOutEverywhere",
  TokenIssued: "TokenIssued",
  AdminStepUp: "AdminStepUp",
  FactorReset: "FactorReset",
  Disabled: "Disabled",
  Enabled: "Enabled",
  KeysRotated: "KeysRotated",
}

enum AuditOutcome {
  Succeeded: "Succeeded",
  Refused: "Refused",
}
