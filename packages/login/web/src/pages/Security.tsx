import { Button, ButtonLink, Card, Dialog } from "@remit/ui/auth";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { type Answer, FAILURE_EVENT, get, leave, post, readerOriginOf } from "../api";
import { addPasskey, passkeysSupported } from "../passkeys";
import {
  BackupCodeList,
  Failure,
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
import { AppSetup } from "./Invite";

export interface Passkey {
  readonly id: string;
  readonly name: string;
}

export interface Account {
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

export type SecurityDialog =
  | { readonly kind: "remove-passkey"; readonly passkey: Passkey }
  | { readonly kind: "change-password" }
  | { readonly kind: "codes"; readonly codes: readonly string[] }
  | { readonly kind: "add-app" };

export interface SecurityFailure {
  readonly title: string;
  readonly message: string;
}

export interface SecurityViewProps {
  readonly account: Account;
  readonly passkeys: boolean;
  readonly notice: string | null;
  readonly failure: SecurityFailure | null;
  readonly dialog: SecurityDialog | null;
  readonly busy: boolean;
  readonly onOpen: (dialog: SecurityDialog) => void;
  readonly onClose: () => void;
  readonly onRemovePasskey: (passkey: Passkey) => void;
  readonly onAddPasskey: () => void;
  readonly onChangePassword: (event: FormEvent<HTMLFormElement>) => void;
  readonly onNewCodes: () => void;
  readonly onTurnOff: () => void;
  readonly onSignOutEverywhere: () => void;
  readonly addApp: ReactNode;
  readonly mailSecurityUrl: string | null;
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold text-fg">{title}</h2>
    <Card className="divide-y divide-line">{children}</Card>
  </section>
);

const Row = ({ title, sub, action }: { title: string; sub?: string; action: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 px-4 py-3">
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-sm text-fg">{title}</span>
      {sub ? <span className="text-xs text-fg-muted">{sub}</span> : null}
    </div>
    {action}
  </div>
);

const Action = ({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) => (
  <Button variant={danger ? "danger" : "secondary"} size="sm" onClick={onClick}>
    {children}
  </Button>
);

const SecurityDialogFrame = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) => (
  <Dialog open onClose={onClose} title={title}>
    <div className="flex flex-col gap-4 p-5">
      <p aria-hidden="true" className="text-md font-semibold text-fg">
        {title}
      </p>
      {children}
    </div>
  </Dialog>
);

const Cancel = ({ onClose, focus }: { onClose: () => void; focus?: boolean }) => (
  <Button variant="ghost" onClick={onClose} ref={focus ? focusOnMount : undefined}>
    Cancel
  </Button>
);

const DialogBody = ({ props }: { props: SecurityViewProps }) => {
  const { dialog, busy, onClose } = props;
  if (dialog === null) return null;
  switch (dialog.kind) {
    case "remove-passkey":
      return (
        <SecurityDialogFrame title={`Remove the passkey ${dialog.passkey.name}?`} onClose={onClose}>
          <Text>That device can no longer sign you in. Your other passkeys stay as they are.</Text>
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() => props.onRemovePasskey(dialog.passkey)}
              disabled={busy}
            >
              Remove
            </Button>
            <Cancel onClose={onClose} focus />
          </div>
        </SecurityDialogFrame>
      );
    case "change-password":
      return (
        <SecurityDialogFrame title="Change your password" onClose={onClose}>
          <Form onSubmit={props.onChangePassword}>
            <PasswordField
              id="current"
              label="Current password"
              autoComplete="current-password"
              required
              ref={focusOnMount}
            />
            <PasswordField
              id="next"
              label="New password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              hint={NEW_PASSWORD_HINT}
            />
            <Muted>Other devices are signed out.</Muted>
            <Submit disabled={busy}>Change password</Submit>
          </Form>
          <Cancel onClose={onClose} />
        </SecurityDialogFrame>
      );
    case "codes":
      return (
        <SecurityDialogFrame title="Your new backup codes" onClose={onClose}>
          <Notice title="Your old codes no longer work">You see these codes only now.</Notice>
          <BackupCodeList codes={dialog.codes} doneLabel="Done" onDone={onClose} />
        </SecurityDialogFrame>
      );
    case "add-app":
      return (
        <SecurityDialogFrame title="Add an authenticator app" onClose={onClose}>
          {props.addApp}
        </SecurityDialogFrame>
      );
  }
};

export const SecurityView = (props: SecurityViewProps) => {
  const { account, passkeys, notice, failure, onOpen, mailSecurityUrl } = props;
  return (
    <Page title="Security" wide>
      {mailSecurityUrl === null ? null : <a href={mailSecurityUrl}>Back to mail</a>}
      <Muted>Signed in as {account.email}</Muted>
      {notice ? <Notice tone="success" title={notice} /> : null}
      {failure ? (
        <Notice tone="danger" title={failure.title} report={`${failure.title}: ${failure.message}`}>
          {failure.message}
        </Notice>
      ) : null}

      <Section title="Password">
        <Row
          title="Password"
          action={
            <Action onClick={() => onOpen({ kind: "change-password" })}>Change password</Action>
          }
        />
      </Section>

      <Section title="Passkeys">
        {account.passkeys.map((passkey) => (
          <Row
            key={passkey.id}
            title={passkey.name}
            action={
              <Action onClick={() => onOpen({ kind: "remove-passkey", passkey })}>Remove</Action>
            }
          />
        ))}
        {account.passkeys.length === 0 ? <Row title="No passkeys yet" action={null} /> : null}
        {passkeys ? (
          <div className="px-4 py-3">
            <Button variant="secondary" onClick={props.onAddPasskey}>
              Add a passkey
            </Button>
          </div>
        ) : (
          <div className="p-3">
            <Notice title="This browser cannot add passkeys">
              Your saved passkeys still show here and you can remove them. To add one, open this
              page in another browser.
            </Notice>
          </div>
        )}
      </Section>

      <Section title="Authenticator app">
        {account.app ? (
          <>
            <Row
              title="On"
              sub="Turning off also removes your backup codes"
              action={<Action onClick={props.onTurnOff}>Turn off</Action>}
            />
            <Row
              title="Backup codes"
              sub="Making new codes replaces your old codes"
              action={<Action onClick={props.onNewCodes}>Make new codes</Action>}
            />
          </>
        ) : (
          <Row
            title="Off"
            sub="Type a code from an app on your phone"
            action={
              <Action onClick={() => onOpen({ kind: "add-app" })}>Add an authenticator app</Action>
            }
          />
        )}
      </Section>

      <Section title="Sign out">
        <Row
          title="Signed in on this device"
          action={
            <ButtonLink variant="secondary" size="sm" href="/sign-out">
              Sign out
            </ButtonLink>
          }
        />
        <Row
          title="Every device and browser"
          sub="Other devices sign out within 15 minutes"
          action={
            <Button
              variant="danger"
              size="sm"
              disabled={props.busy}
              onClick={props.onSignOutEverywhere}
            >
              Sign out everywhere
            </Button>
          }
        />
      </Section>
      <DialogBody props={props} />
    </Page>
  );
};

export const Security = () => {
  const [account, setAccount] = useState<Account | null | string | undefined>(undefined);
  const [failure, setFailure] = useState<SecurityFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SecurityDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [mailSecurityUrl, setMailSecurityUrl] = useState<string | null>(null);

  const reload = useCallback(() => {
    loadAccount().then(setAccount);
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    readerOriginOf()
      .then((origin) => setMailSecurityUrl(new URL("/settings/security", origin).toString()))
      .catch(() => setMailSecurityUrl(null));
  }, []);

  const run = async (
    change: () => Promise<Answer>,
    success: string,
    failedTitle: string,
  ): Promise<Answer> => {
    setFailure(null);
    setNotice(null);
    setBusy(true);
    const answer = await change();
    setBusy(false);
    if (!answer.ok) {
      setDialog(null);
      setFailure({ title: failedTitle, message: answer.message });
      return answer;
    }
    setDialog(null);
    setNotice(success);
    reload();
    return answer;
  };

  if (account === undefined) {
    return (
      <Page title="Security">
        <Muted>Loading…</Muted>
      </Page>
    );
  }
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
        <Text>Sign in to manage your password, passkeys and authenticator app.</Text>
        <ButtonLink href="/sign-in">Sign in</ButtonLink>
      </Page>
    );
  }

  const securityAction = (path: string, success: string, failedTitle: string) => async () => {
    const answer = await run(() => post(path), success, failedTitle);
    if (answer.ok && Array.isArray(answer.body.backupCodes)) {
      setDialog({
        kind: "codes",
        codes: answer.body.backupCodes.filter((code): code is string => typeof code === "string"),
      });
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
      "The password did not change",
    );
  };

  return (
    <SecurityView
      account={account}
      mailSecurityUrl={mailSecurityUrl}
      passkeys={passkeysSupported()}
      notice={notice}
      failure={failure}
      dialog={dialog}
      busy={busy}
      onOpen={setDialog}
      onClose={() => setDialog(null)}
      onSignOutEverywhere={async () => {
        setBusy(true);
        const answer = await post("/app/sign-out-everywhere");
        const failure = answer.ok ? await leave(answer) : answer.message;
        if (failure === null) return;
        setBusy(false);
        window.dispatchEvent(new CustomEvent(FAILURE_EVENT, { detail: failure }));
      }}
      onRemovePasskey={(passkey) =>
        run(
          () => post("/api/auth/passkey/delete-passkey", { id: passkey.id }),
          "Passkey removed.",
          "The passkey was not removed",
        )
      }
      onAddPasskey={() => run(addPasskey, "Passkey added.", "The passkey was not added")}
      onChangePassword={changePassword}
      onNewCodes={securityAction(
        "/app/security/backup-codes",
        "New backup codes made.",
        "No new backup codes were made",
      )}
      onTurnOff={securityAction(
        "/app/security/disable-app",
        "Authenticator app removed.",
        "The authenticator app was not turned off",
      )}
      addApp={
        <AppSetup
          onDone={(codes) => {
            setDialog({ kind: "codes", codes });
            setNotice("Authenticator app added.");
            reload();
          }}
        />
      }
    />
  );
};
