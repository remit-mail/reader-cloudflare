import { Banner, Button, ButtonLink, Input, MessageListLoading, Select } from "@remit/ui";
import { type FormEvent, useState } from "react";
import { AccountForm } from "./account-form";
import { type Account, api } from "./api";
import { type Composing, EMPTY_DRAFT } from "./compose";
import { Mail } from "./mail";
import { SignOutContext, useCall } from "./session";
import { useLoad } from "./use-load";

const SignedOut = ({ reason }: { readonly reason: string }) => (
  <main className="flex min-h-dvh items-center justify-center bg-surface p-6">
    <Banner tone="danger" className="flex max-w-lg flex-col gap-3">
      <p>You are signed out. {reason}</p>
      <ButtonLink href="/">Sign in again</ButtonLink>
    </Banner>
  </main>
);

const Workspace = () => {
  const call = useCall();
  const [me] = useLoad(() => call(api.me()), "me");
  const [accounts, reloadAccounts] = useLoad(() => call(api.accounts()), "accounts");
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [composing, setComposing] = useState<Composing | null>(null);
  const [composeKey, setComposeKey] = useState(0);

  const list: readonly Account[] = accounts.kind === "ready" ? accounts.value : [];
  const account = list.find((entry) => entry.accountId === picked) ?? list[0];

  const compose = (draft: Composing["draft"] | null): void => {
    if (draft === null) {
      setComposing(null);
      return;
    }
    setComposeKey(composeKey + 1);
    setComposing({ key: composeKey + 1, draft });
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSearch(query.trim());
  };

  const body = (() => {
    if (accounts.kind === "loading") return <MessageListLoading />;
    if (accounts.kind === "failed") {
      return (
        <Banner tone="danger" className="m-4">
          Could not load your accounts: {accounts.reason}{" "}
          <Button size="sm" variant="secondary" onClick={reloadAccounts}>
            Retry
          </Button>
        </Banner>
      );
    }
    if (adding || account === undefined) {
      return (
        <div className="p-4">
          <AccountForm
            onCancel={account === undefined ? null : () => setAdding(false)}
            onCreated={(created) => {
              setAdding(false);
              setPicked(created.accountId);
              reloadAccounts();
            }}
          />
        </div>
      );
    }
    return (
      <Mail
        key={account.accountId}
        account={account}
        search={search}
        composing={composing}
        onComposeChange={compose}
      />
    );
  })();

  return (
    <div className="flex min-h-dvh flex-col bg-surface text-fg lg:h-dvh">
      <header className="flex flex-wrap items-center gap-2 border-line border-b px-3 py-2">
        <span className="font-semibold">remit</span>
        {list.length > 0 && (
          <Select
            aria-label="Account"
            value={account?.accountId ?? ""}
            onChange={(event) => {
              setPicked(event.target.value);
              setSearch("");
              setQuery("");
              setComposing(null);
            }}
          >
            {list.map((entry) => (
              <option key={entry.accountId} value={entry.accountId}>
                {entry.name} ({entry.email})
              </option>
            ))}
          </Select>
        )}
        {account !== undefined && !adding && (
          <form className="flex min-w-48 flex-1 items-center gap-2" onSubmit={submitSearch}>
            <Input
              aria-label="Search mail"
              type="search"
              placeholder="Search mail"
              className="flex-1"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (event.target.value === "") setSearch("");
              }}
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
        )}
        {account !== undefined && !adding && (
          <Button onClick={() => compose(EMPTY_DRAFT)}>Compose</Button>
        )}
        {account !== undefined && !adding && (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            Add account
          </Button>
        )}
        <span className="ml-auto text-xs text-fg-muted">
          {me.kind === "ready" ? me.value.email : null}
          {me.kind === "failed" ? `Could not load your identity: ${me.reason}` : null}
        </span>
      </header>
      {body}
    </div>
  );
};

export const App = () => {
  const [signedOut, setSignedOut] = useState<string | null>(null);
  if (signedOut !== null) return <SignedOut reason={signedOut} />;
  return (
    <SignOutContext.Provider value={setSignedOut}>
      <Workspace />
    </SignOutContext.Provider>
  );
};
