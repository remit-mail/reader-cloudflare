import type {
  ConfigDescriptionResponse,
  ConfigExportResponse,
  ConfigImportReport,
  TestConnectionResponse,
} from "@remit/api-openapi-types";
import {
  CreateAccountInputSchema,
  ImportConfigInputSchema,
  TestConnectionInputSchema,
  UpdateAccountInputSchema,
} from "@remit/api-zod-schemas";
import { type AppointFolderRole, importConfig, readConfigForExport } from "@remit/config-transfer";
import {
  CANONICAL_ROLES,
  type CanonicalMailboxRoleValue,
  composeFolderRoleAppointmentLabelName,
  composeFolderRoleAppointmentName,
} from "@remit/data-ports/folder-role";
import { z } from "zod";
import { commit } from "../../commit";
import {
  createAccount,
  decryptCredential,
  ensureAccountConfig,
  updateAccount,
} from "../../db/accounts";
import { openAppDb } from "../../db/client";
import { type ConfigRepositories, openConfigStore } from "../../db/config-store";
import { log } from "../../log";
import type { ImapCredential } from "../../mail/imap-connect";
import { settle, verifyImap, verifySmtp } from "../../mail/send";
import { tenantMail } from "../../stubs";
import { toAccountConfigResponse, toAccountResponse } from "../mappers";
import { type ApiRequest, accountOf, accountsOf, type Handler, parse } from "../request";
import { apiError, conflict, invalid, notFound, ok, optional } from "../respond";

const accountParams = z.object({ accountId: z.string().min(1) });

const UNSUPPORTED_ACCOUNT_FIELDS = [
  "displayName",
  "smtpPassword",
  "syncedServices",
  "signaturePlainText",
  "signatureHtml",
  "composeLanguages",
  "muted",
] as const;

const isCanonicalRole = (role: string): role is CanonicalMailboxRoleValue =>
  CANONICAL_ROLES.some((canonical) => canonical === role);

const folderRoleWriter =
  (repositories: ConfigRepositories): AppointFolderRole =>
  async (accountConfigId, accountId, role, mailboxId, lastKnownPath) => {
    if (!isCanonicalRole(role)) throw new Error(`folder role ${role} is not a canonical role`);
    await repositories.accountSetting.upsert({
      accountConfigId,
      name: composeFolderRoleAppointmentName(accountId, role),
      value: { kind: "String", value: mailboxId },
    });
    await repositories.accountSetting.upsert({
      accountConfigId,
      name: composeFolderRoleAppointmentLabelName(accountId, role),
      value: { kind: "String", value: lastKnownPath },
    });
  };

const exportConfig: Handler = async (_context, request) => {
  const { tenantId } = request.tenant;
  const db = openAppDb(request.env.DB);
  const config = await ensureAccountConfig(db, tenantId);
  const store = openConfigStore(request.env, db, tenantId, config.accountConfigId);
  const document = await readConfigForExport(store.repositories, config.accountConfigId, {
    app: "reader",
    version: commit,
    exportedAt: new Date().toISOString(),
    instance: new URL(request.origin).host,
  });
  log.info("config exported", {
    tenantId,
    schemaVersion: document.schemaVersion,
    accounts: document.accounts.length,
    labels: document.labels.length,
    filters: document.filters.length,
    addressFlags: document.addressFlags.length,
  });
  const body: ConfigExportResponse = { schemaVersion: document.schemaVersion, document };
  return ok(body);
};

const importConfigHandler: Handler = async (_context, request) => {
  const parsed = parse(ImportConfigInputSchema, request.body, "config import");
  if (!parsed.ok) return parsed.response;
  const { tenantId } = request.tenant;
  const mode = parsed.value.mode ?? "validate";
  const db = openAppDb(request.env.DB);
  const config = await ensureAccountConfig(db, tenantId);
  const store = openConfigStore(request.env, db, tenantId, config.accountConfigId);
  const outcome = await importConfig(
    {
      repositories: store.repositories,
      transaction: store.transaction,
      appointFolderRole: folderRoleWriter(store.repositories),
    },
    {
      accountConfigId: config.accountConfigId,
      userId: tenantId,
      document: parsed.value.document,
      mode,
      onExisting: parsed.value.onExisting ?? "abort",
    },
  );
  if (outcome.outcome === "conflict") {
    log.info("config import refused", { tenantId, mode, ...outcome.conflict.details });
    return conflict(outcome.conflict.code, outcome.conflict.message, outcome.conflict.details);
  }
  const { report } = outcome;
  log.info("config import", {
    tenantId,
    mode,
    importId: report.importId ?? null,
    valid: report.valid,
    applied: report.applied,
    schemaVersion: report.schemaVersion,
    items: report.items.length,
    errors: report.errors.map((error) => error.code),
    warnings: report.warnings.length,
    accountsNeedingCredentials: report.accountsNeedingCredentials.length,
  });
  const body: ConfigImportReport = {
    ...optional("importId", report.importId),
    valid: report.valid,
    schemaVersion: report.schemaVersion,
    applied: report.applied,
    items: report.items.map((item) => ({
      section: item.section,
      key: item.key,
      verdict: item.verdict,
      ...optional("reason", item.reason),
    })),
    errors: report.errors.map((error) => ({
      code: error.code,
      message: error.message,
      ...optional("details", error.details),
    })),
    warnings: report.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...optional("details", warning.details),
    })),
    accountsNeedingCredentials: report.accountsNeedingCredentials,
  };
  return ok(body);
};

const updateAccountHandler: Handler = async (context, request) => {
  const params = parse(accountParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const parsed = parse(UpdateAccountInputSchema, request.body ?? {}, "account update");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  const unsupported = UNSUPPORTED_ACCOUNT_FIELDS.filter((field) => input[field] !== undefined);
  if (unsupported.length > 0) {
    log.warn("account update not implemented", { fields: unsupported });
    return apiError(
      501,
      "NotImplemented",
      `not implemented on this build: ${unsupported.join(", ")}`,
    );
  }
  if (input.password === "") return invalid("A password cannot be empty");
  const account = await accountOf(request, params.value.accountId);
  if (account === undefined) return notFound("Account");
  const { tenantId } = request.tenant;
  const updated = await updateAccount(
    request.env,
    openAppDb(request.env.DB),
    tenantId,
    account,
    {
      ...optional("imapHost", input.imapHost),
      ...optional("imapPort", input.imapPort),
      ...optional("imapTls", input.imapTls),
      ...optional("imapStartTls", input.imapStartTls),
      ...optional("smtpEnabled", input.smtpEnabled),
      ...optional("smtpHost", input.smtpHost),
      ...optional("smtpPort", input.smtpPort),
      ...optional("smtpTls", input.smtpTls),
      ...optional("smtpStartTls", input.smtpStartTls),
      ...optional("smtpUsername", input.smtpUsername),
      ...optional("isActive", input.isActive),
    },
    input.password ?? null,
  );
  log.info("account updated", {
    tenantId,
    accountId: account.accountId,
    password: input.password !== undefined,
  });
  const mailboxes = await tenantMail(request.env, tenantId).listMailboxRows([account.accountId]);
  return ok(toAccountResponse(updated, mailboxes));
};

const getConfig: Handler = async (_context, request) => {
  const db = openAppDb(request.env.DB);
  const config = await ensureAccountConfig(db, request.tenant.tenantId);
  const accounts = await accountsOf(request);
  const mailboxes = await tenantMail(request.env, request.tenant.tenantId).listMailboxRows(
    accounts.map((account) => account.accountId),
  );
  const body: ConfigDescriptionResponse = {
    accountConfig: toAccountConfigResponse(config),
    accounts: accounts.map((account) => toAccountResponse(account, mailboxes)),
    semanticSearchEnabled: false,
  };
  return ok(body);
};

const createAccountHandler: Handler = async (_context, request) => {
  const parsed = parse(CreateAccountInputSchema, request.body, "account");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  if (input.authType !== undefined && input.authType !== "password") {
    return invalid("Only password accounts can be added here");
  }
  if (input.password === undefined || input.password === "") {
    return invalid("A password is required");
  }
  const db = openAppDb(request.env.DB);
  const account = await createAccount(request.env, db, request.tenant.tenantId, {
    input,
    password: input.password,
  });
  log.info("account created", { tenantId: request.tenant.tenantId, accountId: account.accountId });
  return ok(toAccountResponse(account, []));
};

const storedPassword = async (
  request: ApiRequest,
  accountId: string | undefined,
): Promise<string | null> => {
  if (accountId === undefined) return null;
  const account = await accountOf(request, accountId);
  if (account === undefined) return null;
  const secret = await decryptCredential(
    request.env,
    openAppDb(request.env.DB),
    request.tenant.tenantId,
    accountId,
  );
  return secret.ok ? secret.plaintext : null;
};

const testConnection: Handler = async (_context, request) => {
  const parsed = parse(TestConnectionInputSchema, request.body, "connection settings");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  const password = input.password ?? (await storedPassword(request, input.accountId));
  if (password === null) {
    return input.accountId === undefined
      ? invalid("A password is required")
      : notFound("Account credential");
  }
  const imap: ImapCredential = {
    host: input.imapHost,
    port: input.imapPort,
    secure: input.imapTls,
    username: input.username,
    password,
  };
  const imapResult = await settle(verifyImap(imap));
  const smtpHost = input.smtpHost;
  const smtpResult =
    smtpHost === undefined || smtpHost === ""
      ? null
      : await settle(
          verifySmtp({
            host: smtpHost,
            port: input.smtpPort ?? 587,
            secure: input.smtpTls ?? false,
            username: input.smtpUsername ?? input.username,
            password: input.smtpPassword ?? password,
          }),
        );
  log.info("connection tested", {
    tenantId: request.tenant.tenantId,
    imapHost: input.imapHost,
    imap: imapResult.ok,
    smtp: smtpResult?.ok ?? null,
  });
  const body: TestConnectionResponse = {
    imapSuccess: imapResult.ok,
    ...optional("imapError", imapResult.ok ? null : imapResult.reason),
    ...optional("smtpSuccess", smtpResult?.ok),
    ...optional("smtpError", smtpResult === null || smtpResult.ok ? null : smtpResult.reason),
  };
  return ok(body);
};

export const configHandlers = {
  ConfigOperations_getConfig: getConfig,
  ConfigOperations_exportConfig: exportConfig,
  ConfigOperations_importConfig: importConfigHandler,
  AccountOperations_createAccount: createAccountHandler,
  AccountDetailOperations_updateAccount: updateAccountHandler,
  AccountOperations_testConnection: testConnection,
} satisfies Record<string, Handler>;
