import { type FormEvent, useState } from "react";
import { navigate, post } from "../api";
import { Failure, Field, Notice, Page } from "../ui";

export const Reset = () => {
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("email") ?? "");
    setBusy(true);
    const answer = await post("/app/reset/request", { email: address });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    setEmail(address);
  };

  const reset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const answer = await post("/api/auth/email-otp/reset-password", {
      email,
      otp: String(form.get("otp") ?? "").trim(),
      password: form.get("password"),
    });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    navigate("/sign-in");
  };

  if (email === null) {
    return (
      <Page title="Reset your password">
        <Failure message={error} />
        <form onSubmit={request}>
          <Field id="email" label="Email" type="email" autoComplete="username" required />
          <button type="submit" className="button primary" disabled={busy}>
            Send a code
          </button>
        </form>
      </Page>
    );
  }
  return (
    <Page title="Enter your code">
      <Notice>
        If {email} has an account, a code is on its way. It expires in 10 minutes. Your second step
        stays as it is.
      </Notice>
      <Failure message={error} />
      <form onSubmit={reset}>
        <Field id="otp" label="Code" inputMode="numeric" autoComplete="one-time-code" required />
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <button type="submit" className="button primary" disabled={busy}>
          Set the password
        </button>
      </form>
    </Page>
  );
};
