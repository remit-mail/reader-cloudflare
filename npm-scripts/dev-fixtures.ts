import type {
  RemitImapCreateAccountInput,
  RemitImapCreateCalendarEventInput,
  RemitImapCreateCalendarInput,
  RemitImapCreateOutboxMessageInput,
} from "@remit/api-http-client";

export const ACCOUNT: RemitImapCreateAccountInput = {
  email: "dev@example.com",
  displayName: "Dev fixtures",
  authType: "password",
  password: "dev-fixture-password",
  imapHost: "imap.example.invalid",
  imapPort: 993,
  imapTls: true,
  imapStartTls: false,
  smtpEnabled: false,
};

export const DRAFTS: readonly Omit<RemitImapCreateOutboxMessageInput, "accountId">[] = [
  {
    toAddresses: ["alice@example.com"],
    subject: "Quarterly report draft",
    textBody: "Hi Alice,\n\nThe figures for Q3 are attached in the next version.\n",
  },
  {
    toAddresses: ["bob@example.org"],
    ccAddresses: ["carol@example.org"],
    subject: "Lunch on Thursday?",
    textBody: "Bob, Carol: does Thursday at noon still work?\n",
  },
  {
    toAddresses: ["support@example.com"],
    subject: "Invoice question",
    htmlBody: "<p>Could you resend invoice <strong>2026-0042</strong>?</p>",
  },
];

export const CALENDAR: RemitImapCreateCalendarInput = {
  displayName: "Dev fixtures",
  urlSegment: "dev-fixtures",
  color: "Cal2",
  timezone: "Europe/Amsterdam",
};

export const EVENTS_WINDOW = { from: "2026-01-01T00:00:00+00:00", to: "2027-01-01T00:00:00+00:00" };

export const WEEKLY_SUMMARY = "Weekly planning";

export const EVENTS: readonly Omit<RemitImapCreateCalendarEventInput, "calendarId">[] = [
  {
    summary: WEEKLY_SUMMARY,
    start: "2026-01-05T09:00:00+01:00",
    end: "2026-01-05T09:30:00+01:00",
    timeZone: "Europe/Amsterdam",
    recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
  },
  {
    summary: "Release review",
    location: "Room 2",
    start: "2026-11-12T14:00:00+01:00",
    end: "2026-11-12T15:00:00+01:00",
    timeZone: "Europe/Amsterdam",
  },
  {
    summary: "Team offsite",
    start: "2026-11-19",
    end: "2026-11-21",
    allDay: true,
  },
];
