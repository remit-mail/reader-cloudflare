import {
  accountOperationsCreateAccount,
  calendarEventOperationsCreateCalendarEvent,
  calendarEventOperationsListCalendarEvents,
  calendarOperationsCreateCalendar,
  calendarOperationsListCalendars,
  configOperationsGetConfig,
  outboxOperationsCreateOutboxMessage,
  outboxOperationsListOutboxMessages,
} from "@remit/api-http-client";
import { connect, must } from "./dev-api.ts";
import { ACCOUNT, CALENDAR, DRAFTS, EVENTS, EVENTS_WINDOW } from "./dev-fixtures.ts";

await connect();

const config = await must("get-config", configOperationsGetConfig());
const account =
  config.accounts.find((existing) => existing.email === ACCOUNT.email) ??
  (await must("create-account", accountOperationsCreateAccount({ body: ACCOUNT })));

const outbox = await must("list-outbox", outboxOperationsListOutboxMessages());
const draftSubjects = new Set(outbox.items.map((item) => item.subject));
for (const draft of DRAFTS.filter((fixture) => !draftSubjects.has(fixture.subject))) {
  await must(
    `create-draft ${draft.subject}`,
    outboxOperationsCreateOutboxMessage({ body: { ...draft, accountId: account.accountId } }),
  );
}

const calendars = await must("list-calendars", calendarOperationsListCalendars());
const calendar =
  calendars.items.find((existing) => existing.urlSegment === CALENDAR.urlSegment) ??
  (await must("create-calendar", calendarOperationsCreateCalendar({ body: CALENDAR })));

const events = await must(
  "list-events",
  calendarEventOperationsListCalendarEvents({
    query: { ...EVENTS_WINDOW, calendarId: [calendar.calendarId] },
  }),
);
const eventSummaries = new Set(events.items.map((item) => item.summary));
for (const event of EVENTS.filter((fixture) => !eventSummaries.has(fixture.summary))) {
  await must(
    `create-event ${event.summary}`,
    calendarEventOperationsCreateCalendarEvent({
      body: { ...event, calendarId: calendar.calendarId },
    }),
  );
}

console.log("seed:dev done");
