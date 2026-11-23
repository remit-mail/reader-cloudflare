import { Button } from "@remit/ui/auth";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type Answer, dropLinkToken, navigate, post, takeLinkToken, untilRetry } from "../api";
import {
  FreshLinkSentView,
  LinkExpiredView,
  LinkMissingView,
  type Opening,
  OpeningRemitView,
  useOpenRemit,
} from "../flow";
import { addPasskey, passkeysSupported } from "../passkeys";
import { QrCode } from "../qr";
import { failureOf, type Refusal } from "../refusal";
import {
  BackupCodeList,
  Field,
  Form,
  focusOnMount,
  Muted,
  NEW_PASSWORD_HINT,
  Notice,
  Page,
  PasswordField,
  Submit,
  Text,
} from "../ui";

export type InviteState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly email: string; readonly failure: string | null }
  | { readonly kind: "expired"; readonly failure: string | null }
  | { readonly kind: "fresh-sent" }
  | { readonly kind: "missing" }
  | { readonly kind: "locked"; readonly message: string; readonly retryAt: number | null }
  | { readonly kind: "failed"; readonly message: string };

export interface InviteViewProps {
  readonly state: InviteState;
  readonly busy: boolean;
  readonly onContinue: () => void;
  readonly onFresh: () => void;
}

const Retry = ({
  retryAt,
  busy,
  onRetry,
}: {
  retryAt: number | null;
  busy: boolean;
  onRetry: () => void;
}) => {
  const [ready, setReady] = useState(retryAt === null || retryAt <= Date.now());
  useEffect(() => {
    setReady(retryAt === null || retryAt <= Date.now());
    return untilRetry(retryAt, () => setReady(true));
  }, [retryAt]);
  return (
    <Button onClick={onRetry} disabled={busy || !ready}>
      Retry
    </Button>
  );
};

export const InviteView = ({ state, busy, onContinue, onFresh }: InviteViewProps) => {
  switch (state.kind) {
    case "loading":
      return (
        <Page title="Welcome to remit">
          <Muted>Opening your invite…</Muted>
        </Page>
      );
    case "expired":
      return (
        <LinkExpiredView kind="invite" busy={busy} failure={state.failure} onFresh={onFresh} />
      );
    case "fresh-sent":
      return <FreshLinkSentView kind="invite" />;
    case "missing":
      return <LinkMissingView kind="invite" />;
    case "locked":
      return (
        <Page title="Too many tries">
          <Notice tone="warning" title="This page stopped taking tries">
            {state.message}
          </Notice>
          <Retry retryAt={state.retryAt} busy={busy} onRetry={onContinue} />
        </Page>
      );
    case "failed":
      return (
        <Page title="Welcome to remit">
          <Notice tone="danger" title="The invite did not open" report={state.message}>
            {state.message}
          </Notice>
          <Button onClick={onContinue} disabled={busy}>
            Retry
          </Button>
        </Page>
      );
    case "ready":
      return (
        <Page title="Welcome to remit">
          {state.failure === null ? null : (
            <Notice tone="danger" title="The invite did not open" report={state.failure}>
              {state.failure} Try again in a minute.
            </Notice>
          )}
          <Text>
            This invite is for <strong>{state.email}</strong>.
          </Text>
          <Muted>Press Continue to choose your password. The invite works once.</Muted>
          <Button ref={focusOnMount} onClick={onContinue} disabled={busy} className="w-full">
            {state.failure === null ? "Continue" : "Try again"}
          </Button>
        </Page>
      );
  }
};

const lookupState = (answer: Answer): InviteState => {
  if (answer.ok) {
    return typeof answer.body.email === "string"
      ? { kind: "ready", email: answer.body.email, failure: null }
      : { kind: "failed", message: "The invite response did not include an email address." };
  }
  const failure = failureOf(answer);
  if (failure.kind === "locked")
    return { kind: "locked", message: failure.message, retryAt: failure.retryAt };
  if (answer.status === 410) return { kind: "expired", failure: null };
  return { kind: "failed", message: failure.message };
};

export const Invite = () => {
  const [state, setState] = useState<InviteState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const found = takeLinkToken();
    if (found === null) {
      setState({ kind: "missing" });
      return;
    }
    setToken(found);
    post("/app/invite/lookup", { token: found }).then((answer) => setState(lookupState(answer)));
  }, []);

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

  const redeem = async () => {
    if (state.kind !== "ready") {
      setBusy(true);
      const answer = await post("/app/invite/lookup", { token });
      setBusy(false);
      setState(lookupState(answer));
      return;
    }
    setBusy(true);
    const answer = await post("/app/invite/redeem", { token });
    setBusy(false);
    if (!answer.ok && answer.status === 410) {
      setState({ kind: "expired", failure: null });
      return;
    }
    if (!answer.ok) {
      setState(
        failureOf(answer).kind === "locked"
          ? { kind: "locked", message: answer.message, retryAt: answer.retryAt }
          : { ...state, failure: answer.message },
      );
      return;
    }
    navigate("/welcome/password", { email: state.email, token });
  };

  return <InviteView state={state} busy={busy} onContinue={redeem} onFresh={fresh} />;
};

export type PasswordProblem =
  | { readonly kind: "field"; readonly message: string }
  | { readonly kind: "check-failed"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

const passwordProblem = (answer: Refusal): PasswordProblem => {
  if (failureOf(answer).kind === "server") {
    return { kind: "check-failed", message: answer.message };
  }
  if (answer.code.includes("PASSWORD")) return { kind: "field", message: answer.message };
  return { kind: "refused", message: answer.message };
};

export interface WelcomePasswordViewProps {
  readonly email: string | null;
  readonly problem: PasswordProblem | null;
  readonly busy: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onFresh?: () => void;
}

export const WelcomePasswordView = ({
  email,
  problem,
  busy,
  onSubmit,
  onFresh,
}: WelcomePasswordViewProps) => (
  <Page title="Choose a password">
    {problem?.kind === "check-failed" ? (
      <Notice tone="danger" title="The password check failed" report={problem.message}>
        Try again in a minute. Your password is not set yet.
      </Notice>
    ) : null}
    {problem?.kind === "refused" ? (
      <>
        <Notice tone="danger" title={problem.message} report={problem.message} />
        {onFresh ? (
          <Button onClick={onFresh} disabled={busy}>
            Email me a fresh invite
          </Button>
        ) : null}
      </>
    ) : null}
    {email === null ? null : (
      <dl className="flex gap-2 text-sm">
        <dt className="text-fg-muted">Email</dt>
        <dd className="text-fg">{email}</dd>
      </dl>
    )}
    <Form onSubmit={onSubmit}>
      <PasswordField
        id="password"
        label="New password"
        autoComplete="new-password"
        placeholder="12 to 128 characters"
        minLength={12}
        maxLength={128}
        required
        ref={problem?.kind === "check-failed" ? undefined : focusOnMount}
        hint={NEW_PASSWORD_HINT}
        error={problem?.kind === "field" ? problem.message : null}
      />
      <Submit disabled={busy}>Set password</Submit>
    </Form>
  </Page>
);

export const WelcomePassword = () => {
  const details = window.history.state as { email?: unknown; token?: unknown } | null;
  const email = details?.email;
  const [problem, setProblem] = useState<PasswordProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [sent, setSent] = useState(false);

  const fresh = async () => {
    setBusy(true);
    const answer = await post("/app/link/fresh", { token: details?.token ?? takeLinkToken() });
    setBusy(false);
    if (!answer.ok) {
      setProblem({ kind: "refused", message: answer.message });
      return;
    }
    setSent(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true);
    const answer = await post("/app/welcome/password", { password });
    setBusy(false);
    if (!answer.ok) {
      setExpired(answer.code === "NO_GRANT");
      setProblem(passwordProblem(answer));
      return;
    }
    dropLinkToken();
    navigate("/welcome/second-step");
  };

  if (sent) return <FreshLinkSentView kind="invite" />;
  return (
    <WelcomePasswordView
      email={typeof email === "string" ? email : null}
      problem={problem}
      busy={busy}
      onSubmit={submit}
      onFresh={expired ? fresh : undefined}
    />
  );
};

const secretOf = (uri: string): string => {
  const secret = URL.canParse(uri) ? (new URL(uri).searchParams.get("secret") ?? "") : "";
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
};

export type AppSetupState =
  | { readonly kind: "starting" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "scan";
      readonly uri: string;
      readonly codes: readonly string[];
      readonly error: string | null;
    };

export interface AppSetupViewProps {
  readonly state: AppSetupState;
  readonly busy: boolean;
  readonly onVerify: (event: FormEvent<HTMLFormElement>) => void;
  readonly onRetry: () => void;
  readonly onBack?: () => void;
}

const CopySecret = ({ secret }: { secret: string }) => {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <code className="rounded-md bg-surface-sunken px-2 py-1 font-mono text-sm text-fg">
        {secret}
      </code>
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          navigator.clipboard.writeText(secret.replaceAll(" ", "")).then(
            () => setStatus("Copied"),
            () => setStatus("Not copied. Type it by hand."),
          )
        }
      >
        Copy
      </Button>
      <span role="status" className="text-xs text-fg-muted">
        {status}
      </span>
    </div>
  );
};

export const AppSetupView = ({ state, busy, onVerify, onRetry, onBack }: AppSetupViewProps) => {
  const back = onBack ? (
    <Button variant="ghost" onClick={onBack} className="w-full">
      Choose another way
    </Button>
  ) : null;

  if (state.kind === "starting") {
    return <Muted>Making a key for your app…</Muted>;
  }

  if (state.kind === "failed") {
    return (
      <>
        <Notice tone="danger" title="The app could not be added" report={state.message}>
          {state.message}
        </Notice>
        <Button ref={focusOnMount} onClick={onRetry} className="w-full">
          Try again
        </Button>
        {back}
      </>
    );
  }

  return (
    <>
      <ol className="list-inside list-decimal text-sm text-fg-muted">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan this code with your phone, or type the key below.</li>
      </ol>
      <QrCode value={state.uri} />
      <CopySecret secret={secretOf(state.uri)} />
      <Form onSubmit={onVerify}>
        <Field
          id="code"
          label="3. Type the 6-digit code the app shows"
          placeholder="123 456"
          inputMode="numeric"
          autoComplete="one-time-code"
          className="font-mono"
          required
          ref={focusOnMount}
          error={state.error}
        />
        <Submit disabled={busy}>Confirm</Submit>
      </Form>
      {back}
    </>
  );
};

const enrollApp = async (): Promise<AppSetupState> => {
  const answer = await post("/app/second-step/app");
  if (!answer.ok) {
    return { kind: "failed", message: answer.message };
  }
  const codes = Array.isArray(answer.body.backupCodes)
    ? answer.body.backupCodes.filter((code): code is string => typeof code === "string")
    : [];
  return { kind: "scan", uri: String(answer.body.totpURI ?? ""), codes, error: null };
};

export const AppSetup = ({
  onDone,
  onBack,
}: {
  onDone: (backupCodes: string[]) => void;
  onBack?: () => void;
}) => {
  const [state, setState] = useState<AppSetupState>({ kind: "starting" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    enrollApp().then(setState);
  }, []);

  const start = () => {
    setState({ kind: "starting" });
    enrollApp().then(setState);
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind !== "scan") return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setBusy(true);
    const answer = await post("/api/auth/two-factor/verify-totp", { code });
    setBusy(false);
    if (!answer.ok) {
      setState({
        ...state,
        error:
          answer.status === 401
            ? "That code did not match. The code changes every 30 seconds. Type the newest one."
            : answer.message,
      });
      return;
    }
    onDone([...state.codes]);
  };

  return (
    <AppSetupView state={state} busy={busy} onVerify={verify} onRetry={start} onBack={onBack} />
  );
};

export type OnboardingStep =
  | { readonly kind: "choose" }
  | { readonly kind: "passkey-waiting" }
  | { readonly kind: "passkey-failed"; readonly message: string; readonly cancelled: boolean }
  | { readonly kind: "app" };

const Option = ({
  title,
  text,
  onClick,
  focus,
}: {
  title: string;
  text: string;
  onClick: () => void;
  focus?: boolean;
}) => (
  <button
    type="button"
    ref={focus ? focusOnMount : undefined}
    onClick={onClick}
    className="flex w-full flex-col gap-0.5 rounded-md border border-line bg-surface p-3 text-left hover:border-line-strong hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span className="text-sm font-medium text-fg">{title}</span>
    <span className="text-xs text-fg-muted">{text}</span>
  </button>
);

export interface WelcomeSecondStepViewProps {
  readonly step: OnboardingStep;
  readonly passkeys: boolean;
  readonly opening: Opening | null;
  readonly onPasskey: () => void;
  readonly onApp: () => void;
  readonly onChoose: () => void;
  readonly onSkip: () => void;
  readonly app: ReactNode;
}

export const WelcomeSecondStepView = ({
  step,
  passkeys,
  opening,
  onPasskey,
  onApp,
  onChoose,
  onSkip,
  app,
}: WelcomeSecondStepViewProps) => {
  if (opening !== null) return <OpeningRemitView opening={opening} onRetry={onSkip} />;

  const skip = (
    <Button variant="ghost" onClick={onSkip} className="w-full">
      Skip for now
    </Button>
  );

  switch (step.kind) {
    case "choose":
      return (
        <Page title="Make your account safer">
          <Muted>Add a second way to prove it is you. You can do this now or later.</Muted>
          {passkeys ? (
            <Option
              title="Passkey"
              text="Sign in with your fingerprint, face or phone lock."
              onClick={onPasskey}
              focus
            />
          ) : null}
          <Option
            title="Authenticator app"
            text="Type a 6-digit code from an app on your phone."
            onClick={onApp}
            focus={!passkeys}
          />
          {passkeys ? null : (
            <Notice title="Passkeys do not work in this browser">
              Add a passkey later from the Security page in another browser, or use an authenticator
              app now.
            </Notice>
          )}
          {skip}
        </Page>
      );
    case "passkey-waiting":
      return (
        <Page title="Add a passkey">
          <Muted>Follow the steps your browser shows.</Muted>
          <Button disabled className="w-full">
            Waiting for your browser
          </Button>
        </Page>
      );
    case "passkey-failed":
      return (
        <Page title="Add a passkey">
          <Notice
            tone={step.cancelled ? "warning" : "danger"}
            title="The passkey was not saved"
            report={step.cancelled ? undefined : step.message}
          >
            {step.cancelled
              ? "The browser window closed or timed out. Nothing changed on your account."
              : step.message}
          </Notice>
          <Button ref={focusOnMount} onClick={onPasskey} className="w-full">
            Try again
          </Button>
          <Button variant="secondary" onClick={onChoose} className="w-full">
            Choose another way
          </Button>
          {skip}
        </Page>
      );
    case "app":
      return <Page title="Add an authenticator app">{app}</Page>;
  }
};

export const WelcomeSecondStep = () => {
  const [step, setStep] = useState<OnboardingStep>({ kind: "choose" });
  const { opening, open } = useOpenRemit();

  const passkey = async () => {
    setStep({ kind: "passkey-waiting" });
    const answer = await addPasskey();
    if (!answer.ok) {
      setStep({
        kind: "passkey-failed",
        message: answer.message,
        cancelled: answer.code === "PASSKEY_PROMPT",
      });
      return;
    }
    await open();
  };

  const choose = () => setStep({ kind: "choose" });

  return (
    <WelcomeSecondStepView
      step={step}
      passkeys={passkeysSupported()}
      opening={opening}
      onPasskey={passkey}
      onApp={() => setStep({ kind: "app" })}
      onChoose={choose}
      onSkip={open}
      app={
        <AppSetup
          onDone={(codes) => navigate("/welcome/backup-codes", { codes })}
          onBack={choose}
        />
      }
    />
  );
};

export const BackupCodesView = ({
  codes,
  onDone,
}: {
  codes: readonly string[];
  onDone: () => void;
}) => (
  <Page title="Save your backup codes">
    {codes.length === 0 ? (
      <>
        <Text>These codes were shown once. Make new ones on the Security page.</Text>
        <Button onClick={onDone} className="w-full">
          Continue to remit
        </Button>
      </>
    ) : (
      <>
        <Text>Lost your phone? Use one of these codes to sign in. Each code works once.</Text>
        <Muted>
          You see these codes only now. Store them somewhere safe, away from your phone.
        </Muted>
        <BackupCodeList codes={codes} doneLabel="Continue to remit" onDone={onDone} />
      </>
    )}
  </Page>
);

export const BackupCodes = () => {
  const codes = (window.history.state as { codes?: string[] } | null)?.codes ?? [];
  const { opening, open } = useOpenRemit();
  if (opening !== null) return <OpeningRemitView opening={opening} onRetry={open} />;
  return <BackupCodesView codes={codes} onDone={open} />;
};
