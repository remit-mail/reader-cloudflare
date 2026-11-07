import { ButtonLink } from "@remit/ui";
import { type FormEvent, useEffect, useState } from "react";
import { type Failure, failureOf, lockedUntil, post, type Refused, untilRetry } from "../api";
import {
  Field,
  Form,
  focusOnMount,
  LinkButton,
  Muted,
  NEW_PASSWORD_HINT,
  Notice,
  Page,
  PasswordField,
  ReportLink,
  Submit,
  Text,
  TextLink,
} from "../ui";

export type ResetProblem =
  | Failure
  | { readonly kind: "code"; readonly message: string }
  | { readonly kind: "password"; readonly message: string };

const resetProblem = (answer: Refused): ResetProblem => {
  const failure = failureOf(answer);
  if (failure.kind !== "refused") return failure;
  if (answer.code.includes("PASSWORD")) return { kind: "password", message: answer.message };
  if (answer.code.includes("OTP") || answer.status === 400 || answer.status === 401) {
    return {
      kind: "code",
      message:
        "That code is wrong or too old. A code works for 10 minutes. Send a new code if it has been longer.",
    };
  }
  return failure;
};

export type ResetState =
  | { readonly kind: "email"; readonly failure: string | null }
  | { readonly kind: "code"; readonly email: string; readonly problem: ResetProblem | null }
  | { readonly kind: "done" };

export interface ResetViewProps {
  readonly state: ResetState;
  readonly busy: boolean;
  readonly onRequest: (event: FormEvent<HTMLFormElement>) => void;
  readonly onReset: (event: FormEvent<HTMLFormElement>) => void;
  readonly onResend: () => void;
}

export const ResetView = ({ state, busy, onRequest, onReset, onResend }: ResetViewProps) => {
  if (state.kind === "done") {
    return (
      <Page title="Password changed">
        <Text>You are signed out on every other device. Sign in with your new password.</Text>
        <Muted>Use an authenticator app or a passkey? Sign-in still asks for it.</Muted>
        <ButtonLink href="/sign-in">Sign in</ButtonLink>
      </Page>
    );
  }

  if (state.kind === "email") {
    return (
      <Page title="Reset your password">
        {state.failure === null ? null : (
          <Notice tone="danger" title={state.failure} report={state.failure} />
        )}
        <Muted>Type your email. We send you a code that works for 10 minutes.</Muted>
        <Form onSubmit={onRequest}>
          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            required
            ref={focusOnMount}
          />
          <Submit disabled={busy}>Send code</Submit>
        </Form>
        <TextLink href="/sign-in">Back to sign-in</TextLink>
      </Page>
    );
  }

  const { problem } = state;
  return (
    <Page title="Check your email">
      {problem === null ? (
        <Notice title="If this email has an account, a code is on its way">
          Sent to {state.email}. Look in spam too. Your second step stays as it is.
        </Notice>
      ) : null}
      {problem?.kind === "locked" ? (
        <Notice tone="warning" title="Resetting is paused">
          {problem.message}
        </Notice>
      ) : null}
      {problem?.kind === "server" || problem?.kind === "refused" ? (
        <Notice tone="danger" title="The password was not changed" report={problem.message}>
          {problem.message} Try again in a minute.
        </Notice>
      ) : null}
      <Form onSubmit={onReset}>
        <Field
          id="otp"
          label="Code from the email"
          placeholder="123 456"
          inputMode="numeric"
          autoComplete="one-time-code"
          className="font-mono"
          required
          ref={problem === null || problem.kind === "code" ? focusOnMount : undefined}
          error={problem?.kind === "code" ? problem.message : null}
        />
        <PasswordField
          id="password"
          label="New password"
          autoComplete="new-password"
          placeholder="12 to 128 characters"
          minLength={12}
          maxLength={128}
          required
          hint={NEW_PASSWORD_HINT}
          error={problem?.kind === "password" ? problem.message : null}
        />
        <Submit disabled={busy || lockedUntil(problem) !== null}>Set new password</Submit>
      </Form>
      <LinkButton onClick={onResend}>Didn't get it? Send a new code</LinkButton>
      <p className="text-sm text-fg-muted">
        Still nothing? <ReportLink detail="The reset code email did not arrive." />
      </p>
    </Page>
  );
};

export const Reset = () => {
  const [state, setState] = useState<ResetState>({ kind: "email", failure: null });
  const [busy, setBusy] = useState(false);
  const problem = state.kind === "code" ? state.problem : null;
  useEffect(
    () =>
      untilRetry(lockedUntil(problem), () =>
        setState((current) => (current.kind === "code" ? { ...current, problem: null } : current)),
      ),
    [problem],
  );

  const send = async (email: string): Promise<void> => {
    setBusy(true);
    const answer = await post("/app/reset/request", { email });
    setBusy(false);
    if (!answer.ok) {
      setState({ kind: "email", failure: answer.message });
      return;
    }
    setState({ kind: "code", email, problem: null });
  };

  const request = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return send(String(new FormData(event.currentTarget).get("email") ?? ""));
  };

  const reset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind !== "code") return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const answer = await post("/api/auth/email-otp/reset-password", {
      email: state.email,
      otp: String(form.get("otp") ?? "").trim(),
      password: form.get("password"),
    });
    setBusy(false);
    if (!answer.ok) {
      setState({ ...state, problem: resetProblem(answer) });
      return;
    }
    setState({ kind: "done" });
  };

  return (
    <ResetView
      state={state}
      busy={busy}
      onRequest={request}
      onReset={reset}
      onResend={() => (state.kind === "code" ? send(state.email) : undefined)}
    />
  );
};
