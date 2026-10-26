import type { RemitClient } from "@remit/backend/client";
import { handlers } from "@remit/backend/handlers";
import { type ApiRegistry, serveApi, type UserIdentity } from "@remit/backend/serve";
import { refuseQuota } from "../error-kind";
import { apiConfig } from "./config";
import { localHandlers } from "./local";

export const API_ROOT = "/api";

export type ServedQueues = "sync" | "accountFanout" | "messageManagement" | "smtp";

type Handlers = ApiRegistry<ServedQueues>["handlers"];

type Handler = NonNullable<Handlers[keyof Handlers]>;

const refusingQuota =
  (handler: Handler): Handler =>
  (context, ctx) =>
    handler(context, ctx).catch(refuseQuota);

const quotaRefusing = (registry: Handlers): Handlers =>
  Object.fromEntries(
    Object.entries(registry).flatMap(([operationId, handler]) =>
      handler === undefined ? [] : [[operationId, refusingQuota(handler)]],
    ),
  );

const readerHandlers = {
  AccountDetailOperations_updateAccount: handlers.AccountDetailOperations_updateAccount,
  AccountOperations_testConnection: handlers.AccountOperations_testConnection,
  AddressDetailOperations_updateAddress: handlers.AddressDetailOperations_updateAddress,
  AddressOperations_searchAddresses: handlers.AddressOperations_searchAddresses,
  CalendarDetailOperations_deleteCalendar: handlers.CalendarDetailOperations_deleteCalendar,
  CalendarDetailOperations_getCalendar: handlers.CalendarDetailOperations_getCalendar,
  CalendarDetailOperations_getCalendarFeed: handlers.CalendarDetailOperations_getCalendarFeed,
  CalendarDetailOperations_putCalendarFeed: handlers.CalendarDetailOperations_putCalendarFeed,
  CalendarDetailOperations_revokeCalendarFeed: handlers.CalendarDetailOperations_revokeCalendarFeed,
  CalendarDetailOperations_updateCalendar: handlers.CalendarDetailOperations_updateCalendar,
  CalendarEventDetailOperations_deleteCalendarEvent:
    handlers.CalendarEventDetailOperations_deleteCalendarEvent,
  CalendarEventDetailOperations_getCalendarEvent:
    handlers.CalendarEventDetailOperations_getCalendarEvent,
  CalendarEventDetailOperations_updateCalendarEvent:
    handlers.CalendarEventDetailOperations_updateCalendarEvent,
  CalendarEventOperations_createCalendarEvent: handlers.CalendarEventOperations_createCalendarEvent,
  CalendarEventOperations_listCalendarEvents: handlers.CalendarEventOperations_listCalendarEvents,
  CalendarFreeBusyOperations_listCalendarFreeBusy:
    handlers.CalendarFreeBusyOperations_listCalendarFreeBusy,
  CalendarOperations_createCalendar: handlers.CalendarOperations_createCalendar,
  CalendarOperations_listCalendars: handlers.CalendarOperations_listCalendars,
  CalendarSuggestionActionOperations_acceptCalendarSuggestion:
    handlers.CalendarSuggestionActionOperations_acceptCalendarSuggestion,
  CalendarSuggestionActionOperations_declineCalendarSuggestion:
    handlers.CalendarSuggestionActionOperations_declineCalendarSuggestion,
  CalendarSuggestionActionOperations_dismissCalendarSuggestion:
    handlers.CalendarSuggestionActionOperations_dismissCalendarSuggestion,
  CalendarSuggestionActionOperations_reopenCalendarSuggestion:
    handlers.CalendarSuggestionActionOperations_reopenCalendarSuggestion,
  CalendarSuggestionOperations_listCalendarSuggestions:
    handlers.CalendarSuggestionOperations_listCalendarSuggestions,
  ConfigOperations_exportConfig: handlers.ConfigOperations_exportConfig,
  ConfigOperations_importConfig: handlers.ConfigOperations_importConfig,
  FilterDetailOperations_deleteFilter: handlers.FilterDetailOperations_deleteFilter,
  FilterDetailOperations_getFilter: handlers.FilterDetailOperations_getFilter,
  FilterDetailOperations_updateFilter: handlers.FilterDetailOperations_updateFilter,
  FilterOperations_listFilters: handlers.FilterOperations_listFilters,
  FolderRoleOperations_appointFolderRole: handlers.FolderRoleOperations_appointFolderRole,
  LabelDetailOperations_deleteLabel: handlers.LabelDetailOperations_deleteLabel,
  LabelDetailOperations_getLabel: handlers.LabelDetailOperations_getLabel,
  LabelDetailOperations_updateLabel: handlers.LabelDetailOperations_updateLabel,
  LabelOperations_createLabel: handlers.LabelOperations_createLabel,
  LabelOperations_listLabels: handlers.LabelOperations_listLabels,
  MailboxDetailOperations_getMailbox: handlers.MailboxDetailOperations_getMailbox,
  MailboxOperations_listMailboxes: handlers.MailboxOperations_listMailboxes,
  MeOperations_getExport: handlers.MeOperations_getExport,
  MeOperations_listQuarantine: handlers.MeOperations_listQuarantine,
  MeOperations_listVipSuggestions: handlers.MeOperations_listVipSuggestions,
  MessageBulkOperations_updateFlags: handlers.MessageBulkOperations_updateFlags,
  MessageBulkOperations_updateMessageLabels: handlers.MessageBulkOperations_updateMessageLabels,
  MessageCalendarSuggestionOperations_listMessageCalendarSuggestions:
    handlers.MessageCalendarSuggestionOperations_listMessageCalendarSuggestions,
  MessageOperations_updateMessageFlags: handlers.MessageOperations_updateMessageFlags,
  MicrosoftOAuthOperations_microsoftOAuthStart:
    handlers.MicrosoftOAuthOperations_microsoftOAuthStart,
  OrganizeJobDetailOperations_getOrganizeJob: handlers.OrganizeJobDetailOperations_getOrganizeJob,
  OrganizeOperations_previewOrganize: handlers.OrganizeOperations_previewOrganize,
  OutboxDetailOperations_getOutboxMessage: handlers.OutboxDetailOperations_getOutboxMessage,
  OutboxDetailOperations_sendOutboxMessage: handlers.OutboxDetailOperations_sendOutboxMessage,
  OutboxDetailOperations_updateOutboxMessage: handlers.OutboxDetailOperations_updateOutboxMessage,
  OutboxOperations_createOutboxMessage: handlers.OutboxOperations_createOutboxMessage,
  OutboxOperations_listOutboxMessages: handlers.OutboxOperations_listOutboxMessages,
  SyncOperations_getSyncStatus: handlers.SyncOperations_getSyncStatus,
  SystemOperations_applySystemUpdate: handlers.SystemOperations_applySystemUpdate,
  SystemOperations_getSystemUpdate: handlers.SystemOperations_getSystemUpdate,
  ThreadDetailOperations_listThreadMessages: handlers.ThreadDetailOperations_listThreadMessages,
  ThreadOperations_listThreads: handlers.ThreadOperations_listThreads,
  ThreadOperations_searchThreads: handlers.ThreadOperations_searchThreads,
  UnifiedThreadOperations_listAllThreads: handlers.UnifiedThreadOperations_listAllThreads,
} satisfies Handlers;

const served = serveApi<ServedQueues>({
  handlers: quotaRefusing({ ...readerHandlers, ...localHandlers }),
  publicHandlers: {},
});

export const serveTenantApi = (
  request: Request,
  identity: UserIdentity,
  client: RemitClient<ServedQueues>,
  correlationId: string,
): Promise<Response> => {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(API_ROOT.length);
  return served.handleFetch(
    new Request(url, request),
    { config: apiConfig, client: async () => client, identity: async () => identity },
    correlationId,
  );
};
