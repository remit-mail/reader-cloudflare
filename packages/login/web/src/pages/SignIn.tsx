import { type FormEvent, useState } from "react";
import { type Answer, finish, keepQuery, navigate, post, withOAuth } from "../api";
import { passkeysSupported, signInWithPasskey } from "../passkeys";
import { Failure, Field, Page } from "../ui";

const afterFirstStep = async (answer: Answer, setError: (message: string) => void) => {
  if (!answer.ok) {
    setError(answer.status === 401 ? "That email and password do not match." : answer.message);
    return;
  }
  if (answer.body.twoFactorRedirect === true) {
    navigate(keepQuery("/sign-in/second-step"), { method: "app" });
    return;
  }
  if (Array.isArray(answer.body.secondStep)) {
    navigate(keepQuery("/sign-in/second-step"), { method: "passkey" });
    return;
  }
  await finish(answer);
};

export const SignIn = () => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const answer = await post(
      "/api/auth/sign-in/email",
      withOAuth({ email: form.get("email"), password: form.get("password") }),
    );
    await afterFirstStep(answer, setError);
    setBusy(false);
  };

  const passkey = async () => {
    setBusy(true);
    setError(null);
    const answer = await signInWithPasskey();
    if (answer.ok) await finish(answer);
    else setError(answer.message);
    setBusy(false);
  };

  return (
    <Page title="Sign in to remit">
      <Failure message={error} />
      {passkeysSupported() ? (
        <button type="button" className="button primary" onClick={passkey} disabled={busy}>
          Sign in with a passkey
        </button>
      ) : null}
      <form onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="username" required />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
        />
        <button type="submit" className="button" disabled={busy}>
          Sign in with password
        </button>
      </form>
      <p>
        <a href="/reset">Forgot your password?</a>
      </p>
    </Page>
  );
};

export const SecondStep = () => {
  const method = (window.history.state as { method?: string } | null)?.method ?? "app";
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);

  const done = async (answer: Answer) => {
    if (answer.ok) await finish(answer);
    else setError(answer.status === 401 ? "That code is not right." : answer.message);
    setBusy(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    await done(
      await post(
        backup ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp",
        withOAuth({ code }),
      ),
    );
  };

  const passkey = async () => {
    setBusy(true);
    setError(null);
    await done(await signInWithPasskey());
  };

  if (method === "passkey") {
    return (
      <Page title="Second step">
        <Failure message={error} />
        <p>Your password is right. Confirm with your passkey to finish signing in.</p>
        <button type="button" className="button primary" onClick={passkey} disabled={busy}>
          Use my passkey
        </button>
        <p>
          <a href="/sign-in">Start over</a>
        </p>
      </Page>
    );
  }

  return (
    <Page title="Second step">
      <Failure message={error} />
      <form onSubmit={submit}>
        <Field
          id="code"
          label={backup ? "Backup code" : "Code from your authenticator app"}
          inputMode={backup ? "text" : "numeric"}
          autoComplete="one-time-code"
          required
        />
        <button type="submit" className="button primary" disabled={busy}>
          Continue
        </button>
      </form>
      <button type="button" className="button" onClick={() => setBackup(!backup)}>
        {backup ? "Use the authenticator app" : "Use a backup code"}
      </button>
    </Page>
  );
};
