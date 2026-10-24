import { mailboxLeafName } from "@remit/data-ports/mailbox-name";
import {
  Banner,
  Button,
  ComfortableRow,
  FolderRow,
  MessageListEmpty,
  MessageListError,
  MessageListLoading,
  MessageListLoadingMore,
  ReadingPaneEmpty,
  type ThreadRowData,
} from "@remit/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Account, api, type Mailbox, type MessageSummary, type SyncSummary } from "./api";
import { Compose, type Composing, type Draft, EMPTY_DRAFT } from "./compose";
import { defaultMailbox, depthOf, searchRow, sender, sortMailboxes, summaryRow } from "./format";
import { type Loaded, MessageView } from "./message-view";
import { useCall } from "./session";
import { useLoad } from "./use-load";

const POLL_ROUNDS = 6;
const POLL_INTERVAL_MS = 4000;

type SyncState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "polling"; readonly summary: SyncSummary; readonly round: number }
  | { readonly kind: "done"; readonly summary: SyncSummary }
  | { readonly kind: "failed"; readonly reason: string };

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly messages: readonly MessageSummary[];
      readonly nextBefore: string | null;
      readonly more: "idle" | "loading" | { readonly failed: string };
    };

const replyDraft = ({ message, body }: Loaded): Draft => {
  const from = sender(message);
  const subject = message.subject ?? "";
  const quoted = body.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const header = message.messageIdHeader;
  return {
    ...EMPTY_DRAFT,
    to: from?.email ?? "",
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: `\n\n${quoted}`,
    inReplyTo: header ?? "",
    references: header === null ? [] : [header],
  };
};

const syncText = (sync: SyncState): string | null => {
  if (sync.kind === "running") return "Syncing with the mail server…";
  if (sync.kind === "polling") {
    return `Synced ${sync.summary.mailboxes} mailboxes, ${sync.summary.dumped} messages queued. Loading them…`;
  }
  if (sync.kind === "done") {
    return `Synced ${sync.summary.mailboxes} mailboxes, ${sync.summary.dumped} messages queued.`;
  }
  return null;
};

const MailboxList = ({
  mailboxes,
  selected,
  onSelect,
}: {
  readonly mailboxes: readonly Mailbox[];
  readonly selected: string | null;
  readonly onSelect: (mailboxId: string) => void;
}) => (
  <div role="tree" aria-label="Mailboxes" className="flex flex-col">
    {sortMailboxes(mailboxes).map((mailbox) => {
      const label = mailboxLeafName({
        fullPath: mailbox.path,
        hierarchyDelimiter: mailbox.delimiter,
      });
      return (
        <FolderRow
          key={mailbox.mailboxId}
          label={label}
          depth={depthOf(mailbox)}
          expanded={false}
          ariaLabel={`Open ${mailbox.path}`}
          current={mailbox.mailboxId === selected}
          messageCount={mailbox.messageCount}
          onActivate={() => onSelect(mailbox.mailboxId)}
        />
      );
    })}
  </div>
);

const Rows = ({
  rows,
  active,
  onOpen,
}: {
  readonly rows: readonly ThreadRowData[];
  readonly active: string | null;
  readonly onOpen: (messageId: string) => void;
}) => (
  <div className="flex flex-col">
    {rows.map((row) => (
      <ComfortableRow
        key={row.id}
        thread={row}
        active={row.id === active}
        onClick={() => onOpen(row.id)}
      />
    ))}
  </div>
);

export const Mail = ({
  account,
  search,
  composing,
  onComposeChange,
}: {
  readonly account: Account;
  readonly search: string;
  readonly composing: Composing | null;
  readonly onComposeChange: (draft: Draft | null) => void;
}) => {
  const call = useCall();
  const accountId = account.accountId;
  const [mailboxes, reloadMailboxes] = useLoad(() => call(api.mailboxes(accountId)), accountId);
  const [picked, setPicked] = useState<string | null>(null);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [listNonce, setListNonce] = useState(0);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const mailboxList = mailboxes.kind === "ready" ? mailboxes.value : [];
  const selected =
    mailboxList.find((mailbox) => mailbox.mailboxId === picked)?.mailboxId ??
    defaultMailbox(mailboxList)?.mailboxId ??
    null;

  const [searchResult, reloadSearch] = useLoad(
    () => call(api.search(accountId, search)),
    search === "" ? null : `${accountId}/${search}`,
  );

  useEffect(() => {
    if (selected === null) return;
    let current = true;
    setList((previous) =>
      listNonce > 0 && previous.kind === "ready" ? previous : { kind: "loading" },
    );
    call(api.messages(accountId, selected, null)).then((result) => {
      if (!current) return;
      setList(
        result.ok
          ? { kind: "ready", ...result.value, more: "idle" }
          : { kind: "failed", reason: result.reason },
      );
    });
    return () => {
      current = false;
    };
  }, [accountId, selected, listNonce, call]);

  const loadMore = async (): Promise<void> => {
    if (list.kind !== "ready" || list.nextBefore === null || selected === null) return;
    setList({ ...list, more: "loading" });
    const result = await call(api.messages(accountId, selected, list.nextBefore));
    setList((previous) => {
      if (previous.kind !== "ready") return previous;
      if (!result.ok) return { ...previous, more: { failed: result.reason } };
      return {
        kind: "ready",
        messages: [...previous.messages, ...result.value.messages],
        nextBefore: result.value.nextBefore,
        more: "idle",
      };
    });
  };

  const refresh = useCallback(() => {
    reloadMailboxes();
    setListNonce((value) => value + 1);
  }, [reloadMailboxes]);

  const runSync = async (): Promise<void> => {
    setSync({ kind: "running" });
    const result = await call(api.sync(accountId));
    if (!result.ok) {
      setSync({ kind: "failed", reason: result.reason });
      return;
    }
    refresh();
    for (let round = 1; round <= POLL_ROUNDS; round += 1) {
      if (!live.current) return;
      setSync({ kind: "polling", summary: result.value, round });
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!live.current) return;
      refresh();
    }
    setSync({ kind: "done", summary: result.value });
  };

  const selectMailbox = (mailboxId: string): void => {
    setPicked(mailboxId);
    setOpenMessage(null);
    setListNonce(0);
  };

  const status = syncText(sync);
  const busy = sync.kind === "running" || sync.kind === "polling";

  const listPane = (() => {
    if (search !== "") {
      if (searchResult.kind === "loading") return <MessageListLoading />;
      if (searchResult.kind === "failed") {
        return (
          <MessageListError
            message={`Search failed: ${searchResult.reason}`}
            onRetry={reloadSearch}
          />
        );
      }
      if (searchResult.value.messages.length === 0)
        return <MessageListEmpty searchQuery={search} />;
      return (
        <Rows
          rows={searchResult.value.messages.map(searchRow)}
          active={openMessage}
          onOpen={setOpenMessage}
        />
      );
    }
    if (mailboxes.kind === "ready" && mailboxes.value.length === 0) {
      return <MessageListEmpty scopeLabel="this account — press Sync to fetch mail" />;
    }
    if (list.kind === "loading") return <MessageListLoading />;
    if (list.kind === "failed") {
      return (
        <MessageListError
          message={list.reason}
          onRetry={() => setListNonce((value) => value + 1)}
        />
      );
    }
    if (list.messages.length === 0) return <MessageListEmpty />;
    return (
      <>
        <Rows rows={list.messages.map(summaryRow)} active={openMessage} onOpen={setOpenMessage} />
        {list.more === "loading" && <MessageListLoadingMore />}
        {typeof list.more === "object" && (
          <Banner tone="danger" className="m-2">
            Could not load more messages: {list.more.failed}
          </Banner>
        )}
        {list.nextBefore !== null && list.more !== "loading" && (
          <div className="flex justify-center p-3">
            <Button variant="secondary" size="sm" onClick={loadMore}>
              Load more
            </Button>
          </div>
        )}
      </>
    );
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="flex flex-col gap-3 border-line border-b p-3 lg:w-64 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
        <Button onClick={runSync} disabled={busy}>
          {busy ? "Syncing…" : "Sync"}
        </Button>
        {status !== null && <p className="text-xs text-fg-muted">{status}</p>}
        {sync.kind === "failed" && <Banner tone="danger">Sync failed: {sync.reason}</Banner>}
        {mailboxes.kind === "loading" && <MessageListLoading />}
        {mailboxes.kind === "failed" && (
          <Banner tone="danger">
            Could not load mailboxes: {mailboxes.reason}{" "}
            <Button size="sm" variant="secondary" onClick={reloadMailboxes}>
              Retry
            </Button>
          </Banner>
        )}
        {mailboxes.kind === "ready" && (
          <MailboxList mailboxes={mailboxes.value} selected={selected} onSelect={selectMailbox} />
        )}
      </aside>
      <section
        aria-label="Messages"
        className="flex min-h-[40vh] flex-col border-line border-b lg:w-96 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
      >
        {listPane}
      </section>
      <section
        aria-label="Reading pane"
        className="flex min-w-0 flex-1 flex-col lg:overflow-y-auto"
      >
        {notice !== null && (
          <Banner tone="success" className="m-4" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        )}
        {composing !== null && (
          <div className="p-4">
            <Compose
              key={composing.key}
              accountId={accountId}
              from={account.email}
              initial={composing.draft}
              onClose={() => onComposeChange(null)}
              onSent={(sent) => {
                onComposeChange(null);
                setNotice(`Sent. A copy is in ${sent.sentMailbox}.`);
              }}
            />
          </div>
        )}
        {composing === null && openMessage !== null && (
          <MessageView
            accountId={accountId}
            messageId={openMessage}
            onReply={(loaded) => onComposeChange(replyDraft(loaded))}
          />
        )}
        {composing === null && openMessage === null && <ReadingPaneEmpty />}
      </section>
    </div>
  );
};
