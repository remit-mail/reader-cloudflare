import {
  AccountConfigSchema,
  AccountSchema,
  AddressSchema,
  ConfigImportSchema,
  FilterSchema,
  LabelSchema,
  MailboxSchema,
} from "@remit/api-zod-schemas";
import type { ConfigExportRepositories, ConfigImportRepositories } from "@remit/config-transfer";
import type {
  AccountItem,
  AccountSettingItem,
  AccountSettingValue,
  AddressItem,
  CreateAccountInput,
  CreateAddressInput,
  CreateFilterInput,
  FilterItem,
  FlagsMergePatch,
  LabelItem,
  UpdateAccountInput,
  UpdateFilterInput,
  UpdateLabelInput,
} from "@remit/data-ports";
import { NotFoundError } from "@remit/data-ports/errors";
import { generateBase36Id } from "@remit/drizzle-sqlite-schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { optional } from "../api/respond";
import type { Env } from "../env";
import { log } from "../log";
import { deriveAccountSettingId, deriveConfigImportId } from "../mail/ids";
import type { ImportedAddress } from "../mail/types";
import { tenantMail } from "../stubs";
import { type AppDb, runBatch, type Statement } from "./client";
import {
  accountConfigs,
  accountSettings,
  accounts,
  configImports,
  filters,
  labels,
  tenantAccounts,
} from "./schema";

export type ConfigRepositories = ConfigImportRepositories & ConfigExportRepositories;

export interface ConfigStore {
  readonly repositories: ConfigRepositories;
  readonly transaction: <T>(run: () => Promise<T>) => Promise<T>;
}

type AccountRow = typeof accounts.$inferSelect;
type LabelRow = typeof labels.$inferSelect;
type FilterRow = typeof filters.$inferSelect;

const ADDRESS_PAGE = 1000;
const NO_ACTION = "None";

const RULE_FIELDS = [
  "hasAnchor",
  "matchOperator",
  "literalClauses",
  "actionLabelId",
  "actionMailboxId",
  "scope",
  "expiresAt",
] as const satisfies readonly (keyof UpdateFilterInput)[];

const ACTION_FIELDS = [
  "hasAnchor",
  "matchOperator",
  "literalClauses",
  "actionLabelId",
  "actionMailboxId",
] as const satisfies readonly (keyof UpdateFilterInput)[];

const MutedFlagValueSchema = z.object({
  value: z.boolean(),
  setAt: z.number(),
  setBy: z.string().optional(),
  expiresAt: z.number().optional(),
  reason: z.string().optional(),
});

const AccountSettingValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Boolean"), value: z.boolean() }),
  z.object({ kind: z.literal("String"), value: z.string() }),
  z.object({ kind: z.literal("Number"), value: z.number() }),
  z.object({ kind: z.literal("StringList"), value: z.array(z.string()) }),
  z.object({ kind: z.literal("Map"), value: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("MutedFlag"), value: MutedFlagValueSchema }),
]);

const isAccountSettingValue = (value: unknown): value is AccountSettingValue =>
  AccountSettingValueSchema.safeParse(value).success;

const present = (row: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const itemOf = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, row: object): T =>
  schema.parse(present(row));

const normalize = (value: string): string => value.trim().toLowerCase();

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const toSettingItem = (row: typeof accountSettings.$inferSelect): AccountSettingItem => {
  if (!isAccountSettingValue(row.value)) {
    throw new Error(`account setting ${row.name} holds a value outside the setting kinds`);
  }
  return {
    accountSettingId: row.accountSettingId,
    accountConfigId: row.accountConfigId,
    name: row.name,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const accountPatch = (input: UpdateAccountInput): Partial<AccountRow> => ({
  ...optional("username", input.username),
  ...optional("email", input.email),
  ...optional("authType", input.authType),
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
  ...optional("connectionState", input.connectionState),
});

const filterPatch = (input: UpdateFilterInput): Partial<FilterRow> => {
  const changedAt = nowSeconds();
  const standing = input.scope === "Standing";
  return {
    ...optional("name", input.name),
    ...optional("scope", input.scope),
    ...optional("expiresAt", input.expiresAt),
    ...optional("ttl", input.ttl),
    ...optional("state", input.state),
    ...optional("disabledReason", input.disabledReason),
    ...optional("hasAnchor", input.hasAnchor),
    ...optional("matchOperator", input.matchOperator),
    ...optional("literalClauses", input.literalClauses),
    ...optional("actionLabelId", input.actionLabelId),
    ...optional("actionMailboxId", input.actionMailboxId),
    ...(RULE_FIELDS.some((field) => field in input) ? { ruleChangedAt: changedAt } : {}),
    ...(ACTION_FIELDS.some((field) => field in input) ? { actionChangedAt: changedAt } : {}),
    ...(standing ? { expiresAt: null, ttl: null } : {}),
  };
};

const flagsOf = (patch: FlagsMergePatch): Record<string, unknown> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

export const openConfigStore = (
  env: Env,
  db: AppDb,
  tenantId: string,
  accountConfigId: string,
): ConfigStore => {
  const mail = tenantMail(env, tenantId);
  const statements: Statement[] = [];
  const importedAddresses = new Map<string, ImportedAddress>();
  const accountRows = new Map<string, AccountRow>();
  const labelRows = new Map<string, LabelRow>();
  const filterRows = new Map<string, FilterRow>();
  let open = false;

  const ownConfig = (id: string): void => {
    if (id !== accountConfigId) throw new NotFoundError(`AccountConfig not found: ${id}`);
  };

  const queue = (statement: Statement): void => {
    if (!open) throw new Error("config writes run inside the import batch");
    statements.push(statement);
  };

  const held = <Row>(rows: Map<string, Row>, id: string, what: string): Row => {
    const row = rows.get(id);
    if (row === undefined) throw new NotFoundError(`${what} not found: ${id}`);
    return row;
  };

  const listAccounts = async (id: string): Promise<AccountItem[]> => {
    ownConfig(id);
    const rows = await db
      .select({ account: accounts })
      .from(tenantAccounts)
      .innerJoin(accounts, eq(accounts.accountId, tenantAccounts.accountId))
      .where(and(eq(tenantAccounts.tenantId, tenantId), eq(accounts.accountConfigId, id)))
      .orderBy(asc(accounts.createdAt));
    return rows.map(({ account }) => {
      accountRows.set(account.accountId, account);
      return itemOf(AccountSchema, account);
    });
  };

  const repositories: ConfigRepositories = {
    accountConfig: {
      get: async (id) => {
        ownConfig(id);
        const [row] = await db
          .select()
          .from(accountConfigs)
          .where(eq(accountConfigs.accountConfigId, id));
        if (row === undefined) throw new NotFoundError(`AccountConfig not found: ${id}`);
        return itemOf(AccountConfigSchema, row);
      },
      create: async () => {
        throw new Error(`account config ${accountConfigId} exists before an import runs`);
      },
      update: async (id, input) => {
        const [row] = await db
          .select()
          .from(accountConfigs)
          .where(eq(accountConfigs.accountConfigId, id));
        if (row === undefined) throw new NotFoundError(`AccountConfig not found: ${id}`);
        const now = Date.now();
        const patch = { ...optional("name", input.name), updatedAt: now };
        queue(db.update(accountConfigs).set(patch).where(eq(accountConfigs.accountConfigId, id)));
        return itemOf(AccountConfigSchema, { ...row, ...patch });
      },
    },
    account: {
      listAllByAccountConfig: listAccounts,
      create: async (input: CreateAccountInput) => {
        ownConfig(input.accountConfigId);
        const now = Date.now();
        const row: AccountRow = {
          accountId: input.accountId ?? generateBase36Id(),
          accountConfigId: input.accountConfigId,
          username: input.username,
          email: input.email,
          authType: input.authType ?? "password",
          syncedServices: input.syncedServices ?? ["Mail"],
          grantedScopes: input.grantedScopes ?? [],
          passwordHash: null,
          oauthRefreshTokenHash: null,
          oauthTokenUpdatedAt: null,
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapTls: input.imapTls,
          imapStartTls: input.imapStartTls,
          smtpEnabled: input.smtpEnabled ?? false,
          smtpHost: input.smtpHost ?? "",
          smtpPort: input.smtpPort ?? 587,
          smtpTls: input.smtpTls ?? false,
          smtpStartTls: input.smtpStartTls ?? true,
          smtpUsername: input.smtpUsername ?? "",
          smtpPasswordHash: null,
          isActive: input.isActive,
          connectionState: input.connectionState,
          lastConnectedAt: null,
          lastSyncAt: null,
          lastError: null,
          syncPhase: "idle",
          mailboxCountTotal: null,
          mailboxCountSynced: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        queue(db.insert(accounts).values(row));
        queue(db.insert(tenantAccounts).values({ tenantId, accountId: row.accountId }));
        accountRows.set(row.accountId, row);
        return itemOf(AccountSchema, row);
      },
      update: async (accountId: string, input: UpdateAccountInput) => {
        const row = held(accountRows, accountId, "Account");
        const patch = { ...accountPatch(input), updatedAt: Date.now() };
        queue(db.update(accounts).set(patch).where(eq(accounts.accountId, accountId)));
        const next = { ...row, ...patch };
        accountRows.set(accountId, next);
        return itemOf(AccountSchema, next);
      },
    },
    accountSetting: {
      listByAccountConfig: async (id) => {
        ownConfig(id);
        const rows = await db
          .select()
          .from(accountSettings)
          .where(eq(accountSettings.accountConfigId, id))
          .orderBy(asc(accountSettings.name));
        return rows.map(toSettingItem);
      },
      upsert: async (input) => {
        ownConfig(input.accountConfigId);
        const now = Date.now();
        const row = {
          accountSettingId: await deriveAccountSettingId(input.accountConfigId, input.name),
          accountConfigId: input.accountConfigId,
          name: input.name,
          value: input.value,
          createdAt: now,
          updatedAt: now,
        };
        queue(
          db
            .insert(accountSettings)
            .values(row)
            .onConflictDoUpdate({
              target: accountSettings.accountSettingId,
              set: { value: input.value, updatedAt: now },
            }),
        );
        return row;
      },
    },
    mailbox: {
      listAllByAccount: async (accountId) => {
        const rows = await mail.listMailboxEntities([accountId]);
        return rows.map((row) => itemOf(MailboxSchema, row));
      },
    },
    label: {
      listByAccountConfig: async (id): Promise<LabelItem[]> => {
        ownConfig(id);
        const rows = await db
          .select()
          .from(labels)
          .where(eq(labels.accountConfigId, id))
          .orderBy(asc(labels.createdAt));
        return rows.map((row) => {
          labelRows.set(row.labelId, row);
          return itemOf(LabelSchema, row);
        });
      },
      create: async (input) => {
        ownConfig(input.accountConfigId);
        const now = Date.now();
        const row: LabelRow = {
          labelId: generateBase36Id(),
          accountConfigId: input.accountConfigId,
          name: input.name,
          normalizedName: normalize(input.name),
          color: input.color ?? "Default",
          createdAt: now,
          updatedAt: now,
        };
        queue(db.insert(labels).values(row));
        labelRows.set(row.labelId, row);
        return itemOf(LabelSchema, row);
      },
      update: async (id, labelId, input: UpdateLabelInput) => {
        ownConfig(id);
        const row = held(labelRows, labelId, "Label");
        const patch = {
          ...optional("name", input.name),
          ...optional("normalizedName", input.name === undefined ? null : normalize(input.name)),
          ...optional("color", input.color),
          updatedAt: Date.now(),
        };
        queue(db.update(labels).set(patch).where(eq(labels.labelId, labelId)));
        const next = { ...row, ...patch };
        labelRows.set(labelId, next);
        return itemOf(LabelSchema, next);
      },
    },
    filter: {
      listByAccountConfig: async (id): Promise<FilterItem[]> => {
        ownConfig(id);
        const rows = await db
          .select()
          .from(filters)
          .where(eq(filters.accountConfigId, id))
          .orderBy(asc(filters.createdAt));
        return rows.map((row) => {
          filterRows.set(row.filterId, row);
          return itemOf(FilterSchema, row);
        });
      },
      create: async (input: CreateFilterInput) => {
        ownConfig(input.accountConfigId);
        const now = Date.now();
        const changedAt = nowSeconds();
        const row: FilterRow = {
          filterId: generateBase36Id(),
          accountConfigId: input.accountConfigId,
          name: input.name,
          scope: input.scope,
          expiresAt: input.expiresAt ?? null,
          ttl: input.ttl ?? null,
          state: input.state ?? "Active",
          disabledReason: input.disabledReason ?? "None",
          hasAnchor: input.hasAnchor ?? false,
          ruleChangedAt: changedAt,
          actionChangedAt: changedAt,
          matchOperator: input.matchOperator ?? "And",
          literalClauses: input.literalClauses ?? [],
          actionLabelId: input.actionLabelId ?? NO_ACTION,
          actionMailboxId: input.actionMailboxId ?? NO_ACTION,
          createdAt: now,
          updatedAt: now,
        };
        queue(db.insert(filters).values(row));
        filterRows.set(row.filterId, row);
        return itemOf(FilterSchema, row);
      },
      update: async (id, filterId, input) => {
        ownConfig(id);
        const row = held(filterRows, filterId, "Filter");
        const patch = { ...filterPatch(input), updatedAt: Date.now() };
        queue(db.update(filters).set(patch).where(eq(filters.filterId, filterId)));
        const next = { ...row, ...patch };
        filterRows.set(filterId, next);
        return itemOf(FilterSchema, next);
      },
    },
    address: {
      listAllByAccountConfigPage: async ({ accountConfigId: id, cursor, limit }) => {
        ownConfig(id);
        const page = await mail.listConfigAddresses(id, cursor ?? null, limit ?? ADDRESS_PAGE);
        return {
          items: page.items.map((record) => itemOf(AddressSchema, record)),
          continuationToken: page.next ?? undefined,
        };
      },
      upsertAddress: async (input: CreateAddressInput) => {
        ownConfig(input.accountConfigId);
        if (!open) throw new Error("config writes run inside the import batch");
        const now = Date.now();
        const imported: ImportedAddress = {
          addressId: input.addressId,
          accountConfigId: input.accountConfigId,
          displayName: input.displayName ?? null,
          localPart: input.localPart,
          domain: input.domain,
          normalizedEmail: input.normalizedEmail,
          normalizedCompound: input.normalizedCompound,
          flags: importedAddresses.get(input.addressId)?.flags ?? {},
        };
        importedAddresses.set(input.addressId, imported);
        return itemOf(AddressSchema, {
          ...imported,
          flags: {},
          inboundCount: 0,
          outboundCount: 0,
          replyCount: 0,
          lastInboundAt: 0,
          lastReplyAt: 0,
          createdAt: now,
          updatedAt: now,
        });
      },
      mergeFlags: async (id, addressId, patch): Promise<AddressItem> => {
        ownConfig(id);
        const imported = importedAddresses.get(addressId);
        if (imported === undefined) throw new NotFoundError(`Address not found: ${addressId}`);
        const flags = { ...imported.flags, ...flagsOf(patch) };
        importedAddresses.set(addressId, { ...imported, flags });
        const now = Date.now();
        return itemOf(AddressSchema, {
          ...imported,
          flags: Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== null)),
          inboundCount: 0,
          outboundCount: 0,
          replyCount: 0,
          lastInboundAt: 0,
          lastReplyAt: 0,
          createdAt: now,
          updatedAt: now,
        });
      },
    },
    configImport: {
      listByAccountConfig: async (id) => {
        ownConfig(id);
        const rows = await db
          .select()
          .from(configImports)
          .where(eq(configImports.accountConfigId, id))
          .orderBy(desc(configImports.createdAt));
        return rows.map((row) => itemOf(ConfigImportSchema, row));
      },
      create: async (input) => {
        ownConfig(input.accountConfigId);
        const now = Date.now();
        const row = {
          importId: await deriveConfigImportId(
            input.accountConfigId,
            JSON.stringify(input.document),
          ),
          accountConfigId: input.accountConfigId,
          schemaVersion: input.schemaVersion,
          state: input.state ?? "Pending",
          document: input.document,
          unresolvedRefs: input.unresolvedRefs,
          createdAt: now,
          completedAt: input.completedAt ?? 0,
          updatedAt: now,
        };
        queue(
          db
            .insert(configImports)
            .values(row)
            .onConflictDoUpdate({
              target: configImports.importId,
              set: {
                state: row.state,
                unresolvedRefs: row.unresolvedRefs,
                completedAt: row.completedAt,
                updatedAt: now,
              },
            }),
        );
        return itemOf(ConfigImportSchema, row);
      },
      update: async (importId) => {
        throw new Error(`config import ${importId} is only recorded here, never rebound`);
      },
    },
  };

  const transaction = async <T>(run: () => Promise<T>): Promise<T> => {
    open = true;
    const result = await run();
    open = false;
    const [first, ...rest] = statements;
    if (first !== undefined) await runBatch(db, [first, ...rest]);
    const addresses = [...importedAddresses.values()];
    if (addresses.length > 0) await mail.importAddressFlags(addresses);
    log.info("config import written", {
      tenantId,
      accountConfigId,
      statements: statements.length,
      addresses: addresses.length,
    });
    return result;
  };

  return { repositories, transaction };
};
