import type {
  AccountConfigItem,
  AccountItem,
  IAddressRepository,
  IMailboxRepository,
} from "@remit/data-ports";
import {
  AccountConfigRepo,
  AccountExportRequestRepo,
  AccountRepo,
  AccountSettingRepo,
  ConfigImportRepo,
  FilterRepo,
  LabelRepo,
  type RepositoryDb,
} from "@remit/drizzle-service";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { log } from "../log";
import type { MailAccount } from "../mail/types";
import { tenantMail } from "../stubs";
import { openAppDb } from "./client";

export interface MailPorts {
  readonly address: Pick<
    IAddressRepository,
    "listAllByAccountConfig" | "listAllByAccountConfigPage" | "upsertAddress" | "mergeFlags"
  >;
  readonly mailbox: Pick<IMailboxRepository, "listAllByAccount">;
}

export const composeSettingsRepositories = (
  db: RepositoryDb<Record<string, unknown>>,
  mail: MailPorts,
) => ({
  accountConfig: new AccountConfigRepo(db, mail.address),
  account: new AccountRepo(db, mail.mailbox),
  accountSetting: new AccountSettingRepo(db),
  accountExportRequest: new AccountExportRequestRepo(db),
  configImport: new ConfigImportRepo(db),
  filter: new FilterRepo(db),
  label: new LabelRepo(db),
  address: mail.address,
  mailbox: mail.mailbox,
});

export type SettingsRepositories = ReturnType<typeof composeSettingsRepositories>;

export const tenantMailPorts = (env: Env, tenantId: string): MailPorts => {
  const mail = tenantMail(env, tenantId);
  return {
    address: {
      listAllByAccountConfig: (accountConfigId) => mail.listAddresses(accountConfigId),
      listAllByAccountConfigPage: (page) => mail.listAddressPage(page),
      upsertAddress: (input) => mail.upsertAddress(input),
      mergeFlags: (accountConfigId, addressId, patch) =>
        mail.mergeAddressFlags(accountConfigId, addressId, patch),
    },
    mailbox: {
      listAllByAccount: async (accountId) => [...(await mail.listMailboxItems([accountId]))],
    },
  };
};

export const openSettings = (env: Env, tenantId: string): SettingsRepositories =>
  composeSettingsRepositories(openAppDb(env.DB), tenantMailPorts(env, tenantId));

export const findAccountConfig = async (
  settings: SettingsRepositories,
  tenant: Tenant,
): Promise<AccountConfigItem | undefined> => {
  const page = await settings.accountConfig.listByUser(tenant.userId, { limit: 1 });
  return page.items[0];
};

export const ensureAccountConfig = async (
  settings: SettingsRepositories,
  tenant: Tenant,
): Promise<AccountConfigItem> => {
  const existing = await findAccountConfig(settings, tenant);
  if (existing !== undefined) return existing;
  const created = await settings.accountConfig.create({ userId: tenant.userId });
  log.info("account config created", {
    tenantId: tenant.tenantId,
    accountConfigId: created.accountConfigId,
  });
  return created;
};

export const listTenantAccounts = async (
  settings: SettingsRepositories,
  tenant: Tenant,
): Promise<AccountItem[]> => {
  const config = await findAccountConfig(settings, tenant);
  if (config === undefined) return [];
  const accounts = await settings.account.listAllByAccountConfig(config.accountConfigId);
  return accounts
    .filter((account) => account.deletedAt === undefined)
    .sort((left, right) => left.createdAt - right.createdAt);
};

export const toMailAccount = (tenantId: string, account: AccountItem): MailAccount => ({
  tenantId,
  accountId: account.accountId,
  accountConfigId: account.accountConfigId,
});
