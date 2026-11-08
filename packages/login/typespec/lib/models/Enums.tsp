namespace Login;

enum InviteState {
  Open: "Open",
  Redeemed: "Redeemed",
  Replaced: "Replaced",
  Revoked: "Revoked",
}

enum ResetLinkState {
  Open: "Open",
  Used: "Used",
  Replaced: "Replaced",
}

enum AdminAction {
  Invite: "Invite",
  Disable: "Disable",
  Enable: "Enable",
  ResetFactors: "ResetFactors",
  SignOutEverywhere: "SignOutEverywhere",
  RotateKeys: "RotateKeys",
  RevokeKeys: "RevokeKeys",
  RevokeInvite: "RevokeInvite",
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
  FreshLinkRequested: "FreshLinkRequested",
  PasswordChanged: "PasswordChanged",
  FactorAdded: "FactorAdded",
  FactorRemoved: "FactorRemoved",
  FactorRenamed: "FactorRenamed",
  BackupCodesRegenerated: "BackupCodesRegenerated",
  SignOut: "SignOut",
  SignOutEverywhere: "SignOutEverywhere",
  TokenIssued: "TokenIssued",
  AdminStepUp: "AdminStepUp",
  FactorReset: "FactorReset",
  Disabled: "Disabled",
  Enabled: "Enabled",
  KeysRotated: "KeysRotated",
  KeysRevoked: "KeysRevoked",
  InviteRevoked: "InviteRevoked",
}

enum AuditOutcome {
  Succeeded: "Succeeded",
  Refused: "Refused",
}
