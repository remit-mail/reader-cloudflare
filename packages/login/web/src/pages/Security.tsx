import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Answer, get, post } from "../api";
import { addPasskey, assertPasskey, passkeysSupported } from "../passkeys";
import { Failure, Field, Notice, Page } from "../ui";
import { AppSetup } from "./Invite";

interface Passkey {
  readonly id: string;
  readonly name: string;
}

interface Account {
  readonly email: string;
  readonly app: boolean;
  readonly passkeys: readonly Passkey[];
}

const loadAccount = async (): Promise<Account | null | string> => {
  const session = await get("/api/auth/get-session");
  if (!session.ok) return session.message;
  const user = session.body.user as { email?: string; twoFactorEnabled?: boolean } | undefined;
  if (!user?.email) return null;
  const listed = await fetch("/api/auth/passkey/list-user-passkeys", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => []);
  const passkeys = (Array.isArray(listed) ? listed : []).map(
    (row: { id?: unknown; name?: unknown }) => ({
      id: String(row.id),
      name: typeof row.name === "string" && row.name ? row.name : "Passkey",
    }),
  );
  return { email: user.email, app: Boolean(user.twoFactorEnabled), passkeys };
};

const Confirm = ({ account, onConfirmed }: { account: Account; onConfirmed: () => void }) => {
  const [error, setError] = useState<string | null>(null);
  const done = (answer: Answer) => {
    if (answer.ok) onConfirmed();
    else setError(answer.message);
  };
  const withPasskey = async () => {
    const asserted = await assertPasskey();
    if (!asserted.ok) {
      setError(asserted.answer.message);
      return;
    }
    done(await post("/app/security/confirm", { passkey: asserted.assertion }));
  };
  const withCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = account.app
      ? { totpCode: String(form.get("code") ?? "").trim() }
      : { password: form.get("password") };
    done(await post("/app/security/confirm", body));
  };
  return (
    <div className="card">
      <h2>Confirm it is you</h2>
      <Failure message={error} />
      {account.passkeys.length > 0 ? (
        <button type="button" className="button primary" onClick={withPasskey}>
          Confirm with my passkey
        </button>
      ) : null}
      {account.app || account.passkeys.length === 0 ? (
        <form onSubmit={withCode}>
          {account.app ? (
            <Field
              id="code"
              label="Code from your authenticator app"
              inputMode="numeric"
              required
            />
          ) : (
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
            />
          )}
          <button type="submit" className="button">
            Confirm
          </button>
        </form>
      ) : null}
    </div>
  );
};

export const Security = () => {
  const [account, setAccount] = useState<Account | null | string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [addingApp, setAddingApp] = useState(false);

  const reload = useCallback(() => {
    loadAccount().then(setAccount);
  }, []);
  useEffect(reload, [reload]);

  const run = async (change: () => Promise<Answer>, success: string) => {
    setError(null);
    setNotice(null);
    const answer = await change();
    if (!answer.ok) {
      if (answer.code === "REAUTHENTICATE") setConfirming(true);
      setError(answer.message);
      return answer;
    }
    setNotice(success);
    reload();
    return answer;
  };

  if (account === undefined) return <Page title="Security">Loading…</Page>;
  if (typeof account === "string") {
    return (
      <Page title="Security">
        <Failure message={account} />
      </Page>
    );
  }
  if (account === null) {
    return (
      <Page title="Security">
        <p>Sign in to manage your password, passkeys and authenticator app.</p>
        <a className="button primary" href="/sign-in">
          Sign in
        </a>
      </Page>
    );
  }

  const withPassword =
    (path: string, success: string) => async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const password = new FormData(event.currentTarget).get("password");
      const answer = await run(() => post(path, { password }), success);
      if (answer.ok && Array.isArray(answer.body.backupCodes)) {
        setCodes(
          answer.body.backupCodes.filter((code): code is string => typeof code === "string"),
        );
      }
    };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(
      () =>
        post("/api/auth/change-password", {
          currentPassword: form.get("current"),
          newPassword: form.get("next"),
        }),
      "Your password changed. Other devices are signed out.",
    );
  };

  return (
    <Page title="Security">
      <p className="muted">Signed in as {account.email}</p>
      {notice ? <Notice>{notice}</Notice> : null}
      <Failure message={error} />
      {confirming ? (
        <Confirm
          account={account}
          onConfirmed={() => {
            setConfirming(false);
            setError(null);
            setNotice("Confirmed for 5 minutes.");
          }}
        />
      ) : (
        <button type="button" className="button" onClick={() => setConfirming(true)}>
          Confirm it is you
        </button>
      )}

      <h2>Passkeys</h2>
      <ul className="plain">
        {account.passkeys.map((passkey) => (
          <li key={passkey.id}>
            <span>{passkey.name}</span>
            <button
              type="button"
              className="button danger"
              onClick={() =>
                run(
                  () => post("/api/auth/passkey/delete-passkey", { id: passkey.id }),
                  "Passkey removed.",
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {passkeysSupported() ? (
        <button type="button" className="button" onClick={() => run(addPasskey, "Passkey added.")}>
          Add a passkey
        </button>
      ) : null}

      <h2>Authenticator app</h2>
      {account.app ? (
        <>
          <form
            onSubmit={withPassword(
              "/api/auth/two-factor/generate-backup-codes",
              "New backup codes made.",
            )}
          >
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button type="submit" className="button">
              Make new backup codes
            </button>
          </form>
          <form
            onSubmit={withPassword("/api/auth/two-factor/disable", "Authenticator app removed.")}
          >
            <Field
              id="password-off"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button type="submit" className="button danger">
              Turn off the app
            </button>
          </form>
        </>
      ) : addingApp ? (
        <AppSetup
          onDone={(backupCodes) => {
            setAddingApp(false);
            setCodes(backupCodes);
            reload();
          }}
        />
      ) : (
        <button type="button" className="button" onClick={() => setAddingApp(true)}>
          Add an authenticator app
        </button>
      )}
      {codes ? (
        <div className="codes">
          {codes.map((code) => (
            <span key={code}>{code}</span>
          ))}
        </div>
      ) : null}

      <h2>Password</h2>
      <form onSubmit={changePassword}>
        <Field
          id="current"
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          id="next"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <button type="submit" className="button">
          Change password
        </button>
      </form>

      <h2>Sessions</h2>
      <form method="post" action="/app/sign-out-everywhere">
        <p className="muted">Ends every session. Other devices stop within 15 minutes.</p>
        <button type="submit" className="button danger">
          Sign out everywhere
        </button>
      </form>
    </Page>
  );
};
