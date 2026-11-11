import { Button, ButtonLink } from "@remit/ui/auth";
import { type FormEvent, useEffect, useState } from "react";
import {
  type Answer,
  type Failure,
  failureOf,
  finish,
  keepQuery,
  lockedUntil,
  navigate,
  post,
  type Refused,
  untilRetry,
  withOAuth,
} from "../api";
import { passkeysSupported, signInWithPasskey } from "../passkeys";
import {
  Field,
  Form,
  focusOnMount,
  LinkButton,
  Muted,
  Notice,
  Page,
  PasswordField,
  Submit,
  Text,
  TextLink,
} from "../ui";

export type SignInProblem =
  | Failure
  | { readonly kind: "wrong" }
  | { readonly kind: "disabled" }
  | { readonly kind: "passkey-cancelled" }
  | { readonly kind: "passkey-refused"; readonly message: string };

const passwordProblem = (answer: Refused): SignInProblem => {
  if (answer.status === 401) return { kind: "wrong" };
  if (answer.code === "BANNED_USER") return { kind: "disabled" };
  return failureOf(answer);
};

const passkeyProblem = (answer: Refused): SignInProblem =>
  answer.code === "PASSKEY_PROMPT"
    ? { kind: "passkey-cancelled" }
    : { kind: "passkey-refused", message: answer.message };

const ProblemBanner = ({ problem }: { problem: SignInProblem }) => {
  switch (problem.kind) {
    case "wrong":
      return (
        <Notice tone="danger" title="Wrong email or password">
          Check both and try again. Forgot it?{" "}
          <TextLink href={keepQuery("/reset")}>Reset your password</TextLink>
        </Notice>
      );
    case "locked":
      return (
        <Notice tone="warning" title="Sign-in is paused">
          {problem.message} Forgot your password? Reset it with a link by email.
        </Notice>
      );
    case "disabled":
      return (
        <Notice tone="danger" title="This account is disabled">
          Ask the person who invited you.
        </Notice>
      );
    case "server":
      return (
        <Notice tone="danger" title="Sign-in failed on our side" report={problem.message}>
          This is not your fault. Try again in a minute. If it keeps failing, report it.
        </Notice>
      );
    case "refused":
      return <Notice tone="danger" title={problem.message} report={problem.message} />;
    default:
      return null;
  }
};

export interface SignInViewProps {
  readonly problem: SignInProblem | null;
  readonly busy: boolean;
  readonly passkeys: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onPasskey: () => void;
  readonly onUsePassword: () => void;
}

export const SignInView = ({
  problem,
  busy,
  passkeys,
  onSubmit,
  onPasskey,
  onUsePassword,
}: SignInViewProps) => {
  if (problem?.kind === "passkey-cancelled" || problem?.kind === "passkey-refused") {
    return (
      <Page title="Sign in to remit">
        {problem.kind === "passkey-cancelled" ? (
          <Notice tone="warning" title="The passkey sign-in did not finish">
            The browser window closed or timed out.
          </Notice>
        ) : (
          <Notice tone="danger" title="The passkey sign-in failed" report={problem.message}>
            {problem.message}
          </Notice>
        )}
        <Button ref={focusOnMount} onClick={onPasskey} disabled={busy} className="w-full">
          Try again
        </Button>
        <Button variant="secondary" onClick={onUsePassword} className="w-full">
          Use password
        </Button>
        <TextLink href={keepQuery("/reset")}>Forgot your password?</TextLink>
      </Page>
    );
  }

  return (
    <Page title="Sign in to remit">
      {problem ? <ProblemBanner problem={problem} /> : null}
      <Form onSubmit={onSubmit}>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username webauthn"
          placeholder="you@example.com"
          required
          ref={problem === null ? focusOnMount : undefined}
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          placeholder="Your password"
          required
          ref={problem?.kind === "wrong" ? focusOnMount : undefined}
        />
        <Submit disabled={busy || lockedUntil(problem) !== null}>
          {problem?.kind === "server" ? "Try again" : "Sign in"}
        </Submit>
      </Form>
      <TextLink href={keepQuery("/reset")}>Forgot your password?</TextLink>
      {passkeys ? (
        <>
          <hr className="border-line" />
          <Button variant="secondary" onClick={onPasskey} disabled={busy} className="w-full">
            Sign in with a passkey
          </Button>
        </>
      ) : null}
    </Page>
  );
};

const afterFirstStep = async (
  answer: Answer,
  setProblem: (problem: SignInProblem) => void,
): Promise<void> => {
  if (!answer.ok) {
    setProblem(passwordProblem(answer));
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
  const [problem, setProblem] = useState<SignInProblem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => untilRetry(lockedUntil(problem), () => setProblem(null)), [problem]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    const answer = await post(
      "/api/auth/sign-in/email",
      withOAuth({ email: form.get("email"), password: form.get("password") }),
    );
    if (!answer.ok && answer.status === 401) {
      const password = element.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
    }
    await afterFirstStep(answer, setProblem);
    setBusy(false);
  };

  const passkey = async () => {
    setBusy(true);
    const answer = await signInWithPasskey();
    if (answer.ok) await finish(answer);
    else setProblem(passkeyProblem(answer));
    setBusy(false);
  };

  return (
    <SignInView
      problem={problem}
      busy={busy}
      passkeys={passkeysSupported()}
      onSubmit={submit}
      onPasskey={passkey}
      onUsePassword={() => setProblem(null)}
    />
  );
};

export type SecondStepMethod = "app" | "backup" | "help" | "passkey";

export type SecondStepProblem =
  | Failure
  | { readonly kind: "wrong-code" }
  | { readonly kind: "expired" }
  | { readonly kind: "passkey-cancelled" }
  | { readonly kind: "passkey-other-account" };

const secondStepProblem = (answer: Refused): SecondStepProblem => {
  if (answer.code === "PASSKEY_PROMPT") return { kind: "passkey-cancelled" };
  if (answer.code === "PASSKEY_OF_ANOTHER_ACCOUNT") return { kind: "passkey-other-account" };
  if (answer.code === "INVALID_TWO_FACTOR_COOKIE") return { kind: "expired" };
  if (answer.status === 401) return { kind: "wrong-code" };
  return failureOf(answer);
};

export interface SecondStepViewProps {
  readonly method: SecondStepMethod;
  readonly afterReset: boolean;
  readonly problem: SecondStepProblem | null;
  readonly busy: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onPasskey: () => void;
  readonly onMethod: (method: SecondStepMethod) => void;
}

const SharedBanner = ({ problem }: { problem: SecondStepProblem | null }) => {
  if (problem?.kind === "locked") {
    return (
      <Notice tone="warning" title="Sign-in is paused">
        {problem.message}
      </Notice>
    );
  }
  if (problem?.kind === "server") {
    return (
      <Notice tone="danger" title="The check failed on our side" report={problem.message}>
        Try again in a minute.
      </Notice>
    );
  }
  if (problem?.kind === "refused") {
    return <Notice tone="danger" title={problem.message} report={problem.message} />;
  }
  return null;
};

const PasswordChanged = ({ show }: { show: boolean }) =>
  show ? (
    <Notice tone="success" title="Password changed">
      Every other device is signed out. Finish signing in with your second step.
    </Notice>
  ) : null;

export const SecondStepView = ({
  method,
  afterReset,
  problem,
  busy,
  onSubmit,
  onPasskey,
  onMethod,
}: SecondStepViewProps) => {
  if (problem?.kind === "expired") {
    return (
      <Page title="Sign in again">
        <Text>More than 10 minutes passed since you typed your password. Type it again.</Text>
        <ButtonLink href="/sign-in">Back to sign-in</ButtonLink>
      </Page>
    );
  }

  if (method === "help") {
    return (
      <Page title="Lost your second step?">
        <Text>
          Ask the person who invited you to reset your second step. After that, you sign in with
          your email and password only.
        </Text>
        <Muted>This keeps your mail safe if someone else learns your password.</Muted>
        <ButtonLink variant="secondary" href="/sign-in">
          Back to sign-in
        </ButtonLink>
      </Page>
    );
  }

  if (method === "passkey") {
    const waiting = busy;
    const retry = problem !== null;
    return (
      <Page title="Confirm with your passkey">
        <PasswordChanged show={afterReset && problem === null} />
        {problem?.kind === "passkey-cancelled" ? (
          <Notice tone="warning" title="The passkey check did not finish">
            The browser window closed or timed out. You are not signed in yet.
          </Notice>
        ) : null}
        {problem?.kind === "passkey-other-account" ? (
          <Notice tone="danger" title="This passkey did not work">
            It belongs to another account. Try again and pick the passkey for the account you signed
            in to.
          </Notice>
        ) : null}
        <SharedBanner problem={problem} />
        <Muted>
          {waiting
            ? "Follow the steps your browser shows."
            : "Your password is right. Use the passkey you saved for remit to finish."}
        </Muted>
        <Button ref={focusOnMount} onClick={onPasskey} disabled={waiting} className="w-full">
          {waiting ? "Waiting for your browser" : retry ? "Try again" : "Use your passkey"}
        </Button>
        <LinkButton onClick={() => onMethod("help")}>Can't use your passkey?</LinkButton>
      </Page>
    );
  }

  const backup = method === "backup";
  return (
    <Page title={backup ? "Use a backup code" : "Enter your app code"}>
      <PasswordChanged show={afterReset && problem === null} />
      <SharedBanner problem={problem} />
      <Muted>
        {backup
          ? "Type one of the codes you saved when you set up your app. Each code works once."
          : "Open your authenticator app and type the 6-digit code for remit."}
      </Muted>
      <Form onSubmit={onSubmit}>
        <Field
          key={method}
          id="code"
          label={backup ? "Backup code" : "Code"}
          placeholder={backup ? "abcd-1234" : "123 456"}
          inputMode={backup ? "text" : "numeric"}
          autoComplete="one-time-code"
          className="font-mono"
          required
          ref={focusOnMount}
          error={
            problem?.kind === "wrong-code"
              ? backup
                ? "That backup code did not work. Check it, or use another code."
                : "That code did not match. Type the newest code from the app."
              : null
          }
        />
        <Submit disabled={busy || lockedUntil(problem) !== null}>Continue</Submit>
      </Form>
      <LinkButton onClick={() => onMethod(backup ? "app" : "backup")}>
        {backup ? "Use the app code instead" : "Use a backup code instead"}
      </LinkButton>
      {backup ? null : <LinkButton onClick={() => onMethod("help")}>I have neither</LinkButton>}
    </Page>
  );
};

export const SecondStep = () => {
  const entry = window.history.state as { method?: string; reset?: boolean } | null;
  const initial = entry?.method;
  const afterReset = entry?.reset === true;
  const [method, setMethod] = useState<SecondStepMethod>(initial === "passkey" ? "passkey" : "app");
  const [problem, setProblem] = useState<SecondStepProblem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => untilRetry(lockedUntil(problem), () => setProblem(null)), [problem]);

  const done = async (answer: Answer) => {
    if (answer.ok) await finish(answer);
    else setProblem(secondStepProblem(answer));
    setBusy(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    await done(
      await post(
        method === "backup"
          ? "/api/auth/two-factor/verify-backup-code"
          : "/api/auth/two-factor/verify-totp",
        withOAuth({ code }),
      ),
    );
  };

  const passkey = async () => {
    setBusy(true);
    setProblem(null);
    await done(await signInWithPasskey());
  };

  return (
    <SecondStepView
      method={method}
      afterReset={afterReset}
      problem={problem}
      busy={busy}
      onSubmit={submit}
      onPasskey={passkey}
      onMethod={(next) => {
        setProblem(null);
        setMethod(next);
      }}
    />
  );
};
