import { type FormEvent, useEffect, useState } from "react";
import { finish, navigate, post } from "../api";
import { addPasskey, passkeysSupported } from "../passkeys";
import { QrCode } from "../qr";
import { Failure, Field, Page } from "../ui";

let pendingToken: string | null = null;

const takeToken = (): string | null => {
  const fragment = window.location.hash.slice(1);
  if (fragment) {
    pendingToken = fragment;
    window.history.replaceState(null, "", window.location.pathname);
  }
  return pendingToken;
};

export const Invite = () => {
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = takeToken();
    if (token === null) {
      setError("This invite link no longer works. Ask the person who invited you for a new one.");
      return;
    }
    post("/app/invite/lookup", { token }).then((answer) => {
      if (answer.ok && typeof answer.body.email === "string") setEmail(answer.body.email);
      else if (!answer.ok) setError(answer.message);
    });
  }, []);

  const redeem = async () => {
    setBusy(true);
    const answer = await post("/app/invite/redeem", { token: pendingToken });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    pendingToken = null;
    navigate("/welcome/password", { email });
  };

  return (
    <Page title="You are invited to remit">
      <Failure message={error} />
      {email === null ? null : (
        <>
          <p>
            This invite is for <strong>{email}</strong>. Continue to choose a password.
          </p>
          <button type="button" className="button primary" onClick={redeem} disabled={busy}>
            Continue
          </button>
        </>
      )}
    </Page>
  );
};

export const WelcomePassword = () => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("repeat")) {
      setError("The two passwords differ.");
      return;
    }
    setBusy(true);
    const answer = await post("/app/welcome/password", { password });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    navigate("/welcome/second-step");
  };

  return (
    <Page title="Choose a password">
      <Failure message={error} />
      <p className="muted">12 to 128 characters. Passwords found in known breaches are refused.</p>
      <form onSubmit={submit}>
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <Field
          id="repeat"
          label="Repeat the password"
          type="password"
          autoComplete="new-password"
          required
        />
        <button type="submit" className="button primary" disabled={busy}>
          Continue
        </button>
      </form>
    </Page>
  );
};

export const AppSetup = ({ onDone }: { onDone: (backupCodes: string[]) => void }) => {
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);

  const enable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    const answer = await post("/api/auth/two-factor/enable", { password });
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    const codes = Array.isArray(answer.body.backupCodes)
      ? answer.body.backupCodes.filter((code): code is string => typeof code === "string")
      : [];
    setSetup({ uri: String(answer.body.totpURI ?? ""), codes });
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    const answer = await post("/api/auth/two-factor/verify-totp", { code });
    if (!answer.ok) {
      setError(answer.status === 401 ? "That code is not right." : answer.message);
      return;
    }
    if (setup) onDone(setup.codes);
  };

  if (setup === null) {
    return (
      <form onSubmit={enable}>
        <Failure message={error} />
        <Field
          id="password"
          label="Your password, to add an app"
          type="password"
          autoComplete="current-password"
          required
        />
        <button type="submit" className="button">
          Add an authenticator app
        </button>
      </form>
    );
  }
  return (
    <form onSubmit={verify}>
      <Failure message={error} />
      <p>Scan this code with your authenticator app, then enter the code it shows.</p>
      <QrCode value={setup.uri} />
      <Field id="code" label="Code" inputMode="numeric" autoComplete="one-time-code" required />
      <button type="submit" className="button primary">
        Turn on
      </button>
    </form>
  );
};

export const WelcomeSecondStep = () => {
  const [error, setError] = useState<string | null>(null);

  const passkey = async () => {
    const answer = await addPasskey();
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    await finish({ ok: true, status: 200, body: {} });
  };

  return (
    <Page title="Add a second step">
      <Failure message={error} />
      <p>
        A passkey or an authenticator app protects your account if your password leaks. Once added,
        every password sign-in asks for it.
      </p>
      {passkeysSupported() ? (
        <button type="button" className="button primary" onClick={passkey}>
          Add a passkey
        </button>
      ) : null}
      <AppSetup onDone={(codes) => navigate("/welcome/backup-codes", { codes })} />
      <button
        type="button"
        className="button"
        onClick={() => finish({ ok: true, status: 200, body: {} })}
      >
        Skip for now
      </button>
    </Page>
  );
};

export const BackupCodes = () => {
  const codes = (window.history.state as { codes?: string[] } | null)?.codes ?? [];
  return (
    <Page title="Save your backup codes">
      <p>
        Each code signs you in once if you lose your phone. Store them somewhere safe; they are
        shown only now.
      </p>
      <div className="codes">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <button
        type="button"
        className="button primary"
        onClick={() => finish({ ok: true, status: 200, body: {} })}
      >
        I saved them
      </button>
    </Page>
  );
};
