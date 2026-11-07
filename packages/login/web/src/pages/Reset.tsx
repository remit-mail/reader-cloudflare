import { type FormEvent, useEffect, useState } from "react";
import {
  type Answer,
  dropLinkToken,
  failureOf,
  keepQuery,
  navigate,
  post,
  type Refused,
  takeLinkToken,
} from "../api";
import {
  FreshLinkSentView,
  LinkExpiredView,
  LinkMissingView,
  type Opening,
  OpeningRemitView,
  useOpenRemit,
} from "../flow";
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

export type ResetRequestState =
  | { readonly kind: "email"; readonly failure: string | null }
  | { readonly kind: "sent"; readonly email: string };

export interface ResetRequestViewProps {
  readonly state: ResetRequestState;
  readonly busy: boolean;
  readonly onRequest: (event: FormEvent<HTMLFormElement>) => void;
  readonly onResend: () => void;
}

export const ResetRequestView = ({ state, busy, onRequest, onResend }: ResetRequestViewProps) => {
  if (state.kind === "sent") {
    return (
      <Page title="Check your email" focusTitle>
        <Notice title="If this email has an account, a link is on its way">
          Sent to {state.email}. Look in spam too. The link works once, for 1 hour.
        </Notice>
        <LinkButton onClick={onResend}>Didn't get it? Send a new link</LinkButton>
        <p className="text-sm text-fg-muted">
          Still nothing? <ReportLink detail="The reset link email did not arrive." />
        </p>
        <TextLink href={keepQuery("/sign-in")}>Back to sign-in</TextLink>
      </Page>
    );
  }
  return (
    <Page title="Reset your password">
      {state.failure === null ? null : (
        <Notice tone="danger" title={state.failure} report={state.failure} />
      )}
      <Muted>Type your email. We send you a link that works once, for 1 hour.</Muted>
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
        <Submit disabled={busy}>Send reset link</Submit>
      </Form>
      <TextLink href={keepQuery("/sign-in")}>Back to sign-in</TextLink>
    </Page>
  );
};

export const Reset = () => {
  const [state, setState] = useState<ResetRequestState>({ kind: "email", failure: null });
  const [busy, setBusy] = useState(false);

  const send = async (email: string): Promise<void> => {
    setBusy(true);
    const answer = await post("/app/reset/request", { email });
    setBusy(false);
    setState(answer.ok ? { kind: "sent", email } : { kind: "email", failure: answer.message });
  };

  const request = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return send(String(new FormData(event.currentTarget).get("email") ?? ""));
  };

  return (
    <ResetRequestView
      state={state}
      busy={busy}
      onRequest={request}
      onResend={() => (state.kind === "sent" ? send(state.email) : undefined)}
    />
  );
};

export type NewPasswordProblem =
  | { readonly kind: "field"; readonly message: string }
  | { readonly kind: "locked"; readonly message: string }
  | { readonly kind: "server"; readonly message: string };

export type ResetPasswordState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly email: string; readonly problem: NewPasswordProblem | null }
  | { readonly kind: "expired"; readonly failure: string | null }
  | { readonly kind: "fresh-sent" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string };

export interface ResetPasswordViewProps {
  readonly state: ResetPasswordState;
  readonly opening: Opening | null;
  readonly busy: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onFresh: () => void;
  readonly onRetryOpen: () => void;
}

export const ResetPasswordView = ({
  state,
  opening,
  busy,
  onSubmit,
  onFresh,
  onRetryOpen,
}: ResetPasswordViewProps) => {
  if (opening !== null) return <OpeningRemitView opening={opening} onRetry={onRetryOpen} />;
  switch (state.kind) {
    case "loading":
      return (
        <Page title="Choose a new password">
          <Muted>Opening your link…</Muted>
        </Page>
      );
    case "expired":
      return <LinkExpiredView kind="reset" busy={busy} failure={state.failure} onFresh={onFresh} />;
    case "fresh-sent":
      return <FreshLinkSentView kind="reset" />;
    case "missing":
      return <LinkMissingView kind="reset" />;
    case "failed":
      return (
        <Page title="Choose a new password">
          <Notice tone="danger" title="The link did not open" report={state.message}>
            {state.message} Open the link from your email again in a minute.
          </Notice>
        </Page>
      );
    case "ready": {
      const { problem } = state;
      return (
        <Page title="Choose a new password">
          {problem?.kind === "locked" ? (
            <Notice tone="warning" title="Resetting is paused">
              {problem.message}
            </Notice>
          ) : null}
          {problem?.kind === "server" ? (
            <Notice tone="danger" title="The password was not changed" report={problem.message}>
              {problem.message} Try again in a minute. The link still works.
            </Notice>
          ) : null}
          <dl className="flex gap-2 text-sm">
            <dt className="text-fg-muted">Email</dt>
            <dd className="text-fg">{state.email}</dd>
          </dl>
          <Form onSubmit={onSubmit}>
            <PasswordField
              id="password"
              label="New password"
              autoComplete="new-password"
              placeholder="12 to 128 characters"
              minLength={12}
              maxLength={128}
              required
              ref={problem?.kind === "server" ? undefined : focusOnMount}
              hint={NEW_PASSWORD_HINT}
              error={problem?.kind === "field" ? problem.message : null}
            />
            <Text>Every other device signs out.</Text>
            <Submit disabled={busy || problem?.kind === "locked"}>Set new password</Submit>
          </Form>
        </Page>
      );
    }
  }
};

const lookupState = (answer: Answer): ResetPasswordState => {
  if (answer.ok && typeof answer.body.email === "string") {
    return { kind: "ready", email: answer.body.email, problem: null };
  }
  if (answer.ok) return { kind: "expired", failure: null };
  const failure = failureOf(answer);
  if (failure.kind === "server" || failure.kind === "locked") {
    return { kind: "failed", message: failure.message };
  }
  return { kind: "expired", failure: null };
};

const passwordProblem = (answer: Refused): NewPasswordProblem | "expired" => {
  if (answer.status === 410) return "expired";
  const failure = failureOf(answer);
  if (failure.kind === "locked") return { kind: "locked", message: failure.message };
  if (failure.kind === "server") return { kind: "server", message: failure.message };
  if (answer.code.includes("PASSWORD")) return { kind: "field", message: answer.message };
  return { kind: "server", message: answer.message };
};

export const ResetPassword = () => {
  const [state, setState] = useState<ResetPasswordState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const { opening, open } = useOpenRemit();

  useEffect(() => {
    const found = takeLinkToken();
    if (found === null) {
      setState({ kind: "missing" });
      return;
    }
    setToken(found);
    post("/app/reset/lookup", { token: found }).then((answer) => setState(lookupState(answer)));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true);
    const answer = await post("/app/reset/password", { token, password });
    setBusy(false);
    if (!answer.ok) {
      const problem = passwordProblem(answer);
      setState(problem === "expired" ? { kind: "expired", failure: null } : { ...state, problem });
      return;
    }
    dropLinkToken();
    const secondStep = answer.body.secondStep;
    if (secondStep === "app" || secondStep === "passkey") {
      navigate(keepQuery("/sign-in/second-step"), { method: secondStep, reset: true });
      return;
    }
    await open();
  };

  const fresh = async () => {
    setBusy(true);
    const answer = await post("/app/link/fresh", { token });
    setBusy(false);
    if (!answer.ok) {
      setState({ kind: "expired", failure: answer.message });
      return;
    }
    dropLinkToken();
    setState({ kind: "fresh-sent" });
  };

  return (
    <ResetPasswordView
      state={state}
      opening={opening}
      busy={busy}
      onSubmit={submit}
      onFresh={fresh}
      onRetryOpen={open}
    />
  );
};
