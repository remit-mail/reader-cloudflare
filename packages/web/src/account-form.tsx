import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  PasswordInput,
  Select,
} from "@remit/ui";
import { type FormEvent, useState } from "react";
import { type Account, api, type ServerInput } from "./api";
import { useCall } from "./session";

interface ServerFields {
  readonly host: string;
  readonly port: string;
  readonly security: "tls" | "starttls";
}

const toServer = (fields: ServerFields): ServerInput => ({
  host: fields.host.trim(),
  port: Number(fields.port),
  secure: fields.security === "tls",
});

const isSecurity = (value: string): value is ServerFields["security"] =>
  value === "tls" || value === "starttls";

const ServerSection = ({
  prefix,
  title,
  value,
  onChange,
}: {
  readonly prefix: string;
  readonly title: string;
  readonly value: ServerFields;
  readonly onChange: (value: ServerFields) => void;
}) => (
  <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_6rem_9rem]">
    <legend className="mb-2 text-sm font-medium text-fg">{title}</legend>
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={`${prefix}-host`}>Host</FieldLabel>
      <Input
        id={`${prefix}-host`}
        required
        value={value.host}
        onChange={(event) => onChange({ ...value, host: event.target.value })}
      />
    </div>
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={`${prefix}-port`}>Port</FieldLabel>
      <Input
        id={`${prefix}-port`}
        required
        inputMode="numeric"
        pattern="[0-9]+"
        value={value.port}
        onChange={(event) => onChange({ ...value, port: event.target.value })}
      />
    </div>
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={`${prefix}-security`}>Security</FieldLabel>
      <Select
        id={`${prefix}-security`}
        value={value.security}
        onChange={(event) => {
          if (isSecurity(event.target.value)) onChange({ ...value, security: event.target.value });
        }}
      >
        <option value="tls">TLS</option>
        <option value="starttls">STARTTLS</option>
      </Select>
    </div>
  </fieldset>
);

export const AccountForm = ({
  onCreated,
  onCancel,
}: {
  readonly onCreated: (account: Account) => void;
  readonly onCancel: (() => void) | null;
}) => {
  const call = useCall();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState<ServerFields>({ host: "", port: "993", security: "tls" });
  const [smtp, setSmtp] = useState<ServerFields>({ host: "", port: "465", security: "tls" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await call(
      api.createAccount({
        name: name.trim(),
        username: username.trim(),
        password,
        imap: toServer(imap),
        smtp: toServer(smtp),
      }),
    );
    setPending(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    onCreated(result.value);
  };

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Add a mail account</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="account-name">Account name</FieldLabel>
              <Input
                id="account-name"
                required
                placeholder="Personal"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="account-username">Username</FieldLabel>
              <Input
                id="account-username"
                required
                autoComplete="username"
                placeholder="you@example.com"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <FieldLabel htmlFor="account-password">Password</FieldLabel>
              <PasswordInput
                id="account-password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <ServerSection prefix="imap" title="Incoming (IMAP)" value={imap} onChange={setImap} />
          <ServerSection prefix="smtp" title="Outgoing (SMTP)" value={smtp} onChange={setSmtp} />
          {error !== null && <Banner tone="danger">Could not add the account: {error}</Banner>}
          <div className="flex justify-end gap-2">
            {onCancel !== null && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add account"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
};
