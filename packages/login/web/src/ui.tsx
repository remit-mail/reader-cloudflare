import {
  AuthCard,
  Banner,
  type BannerTone,
  Button,
  Card,
  Checkbox,
  FieldLabel,
  Input,
  type InputProps,
  PasswordInput,
} from "@remit/ui";
import { type ReactNode, useState } from "react";
import { reportUrl } from "./api";

export const focusOnMount = (element: HTMLElement | null): void => {
  element?.focus();
};

export const Page = ({
  title,
  wide = false,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) => {
  const heading = <h1 className="text-xl font-semibold text-fg">{title}</h1>;
  return (
    <AuthCard className={wide ? "justify-start" : undefined}>
      <p className="pb-4 text-center text-lg font-semibold text-fg">remit</p>
      {wide ? (
        <div className="flex flex-col gap-6">
          {heading}
          {children}
        </div>
      ) : (
        <Card raised className="flex flex-col gap-4 p-6">
          {heading}
          {children}
        </Card>
      )}
    </AuthCard>
  );
};

export const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-fg-muted">{children}</p>
);

export const Text = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-fg">{children}</p>
);

export const TextLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="text-sm text-accent underline-offset-2 hover:underline" href={href}>
    {children}
  </a>
);

export const LinkButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    className="self-start text-sm text-accent underline-offset-2 hover:underline"
    onClick={onClick}
  >
    {children}
  </button>
);

export const ReportLink = ({ detail }: { detail: string }) => (
  <a
    className="font-medium underline underline-offset-2"
    href={reportUrl(detail)}
    target="_blank"
    rel="noreferrer"
  >
    Report an issue
  </a>
);

export const Notice = ({
  tone = "info",
  title,
  children,
  report,
}: {
  tone?: BannerTone;
  title: string;
  children?: ReactNode;
  report?: string;
}) => (
  <Banner tone={tone} variant="soft">
    <p className="font-medium">{title}</p>
    {children ? <p>{children}</p> : null}
    {report === undefined ? null : (
      <p className="pt-1">
        <ReportLink detail={report} />
      </p>
    )}
  </Banner>
);

export const Failure = ({ message }: { message: string | null }) =>
  message === null ? null : <Notice tone="danger" title={message} report={message} />;

type FieldProps = { id: string; label: string; error?: string | null };

const fieldError = (id: string, error: string | null | undefined) =>
  error ? (
    <p id={`${id}-error`} className="pt-1 text-xs text-danger">
      {error}
    </p>
  ) : null;

export const Field = ({ id, label, error, ...input }: FieldProps & InputProps) => (
  <div>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Input
      id={id}
      name={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      {...input}
    />
    {fieldError(id, error)}
  </div>
);

export const PasswordField = ({
  id,
  label,
  error,
  hint,
  ...input
}: FieldProps & { hint?: string } & Omit<InputProps, "type" | "trailing" | "variant">) => (
  <div>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <PasswordInput
      id={id}
      name={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
      {...input}
    />
    {fieldError(id, error)}
    {hint && !error ? (
      <p id={`${id}-hint`} className="pt-1 text-xs text-fg-subtle">
        {hint}
      </p>
    ) : null}
  </div>
);

export const NEW_PASSWORD_HINT =
  "Use 12 to 128 characters. Spaces and any symbols are fine. A long phrase is easy to remember.";

export const Form = ({
  onSubmit,
  children,
}: {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) => (
  <form className="flex flex-col gap-4" onSubmit={onSubmit}>
    {children}
  </form>
);

export const Submit = ({
  children,
  disabled,
  variant = "primary",
}: {
  children: ReactNode;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) => (
  <Button type="submit" variant={variant} disabled={disabled} className="w-full">
    {children}
  </Button>
);

const download = (codes: readonly string[]): void => {
  const url = URL.createObjectURL(new Blob([`${codes.join("\n")}\n`], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "remit-backup-codes.txt";
  link.click();
  URL.revokeObjectURL(url);
};

export const BackupCodeList = ({
  codes,
  doneLabel,
  onDone,
}: {
  codes: readonly string[];
  doneLabel: string;
  onDone: () => void;
}) => {
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const copy = () => {
    navigator.clipboard.writeText(codes.join("\n")).then(
      () => setStatus("Copied"),
      () => setStatus("The codes were not copied. Select them and copy by hand."),
    );
  };

  const save = () => {
    try {
      download(codes);
    } catch {
      setStatus("The file was not saved. Use Copy instead.");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken p-3 font-mono text-sm text-fg">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={copy}>
          Copy
        </Button>
        <Button variant="secondary" onClick={save}>
          Download
        </Button>
        <span role="status" className="text-xs text-fg-muted">
          {status}
        </span>
      </div>
      <Checkbox
        label="I saved my backup codes"
        checked={saved}
        onChange={(event) => setSaved(event.currentTarget.checked)}
      />
      <Button disabled={!saved} onClick={onDone} className="w-full">
        {doneLabel}
      </Button>
    </div>
  );
};
