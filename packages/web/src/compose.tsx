import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
} from "@remit/ui";
import { type FormEvent, useState } from "react";
import { api, type Sent } from "./api";
import { useCall } from "./session";

export interface Draft {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
}

export interface Composing {
  readonly key: number;
  readonly draft: Draft;
}

export const EMPTY_DRAFT: Draft = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  inReplyTo: "",
  references: [],
};

const recipients = (value: string): string[] =>
  value
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

type TextField = "to" | "cc" | "bcc" | "subject";

const FIELDS: readonly { readonly field: TextField; readonly label: string }[] = [
  { field: "to", label: "To" },
  { field: "cc", label: "Cc" },
  { field: "bcc", label: "Bcc" },
  { field: "subject", label: "Subject" },
];

export const Compose = ({
  accountId,
  from,
  initial,
  onSent,
  onClose,
}: {
  readonly accountId: string;
  readonly from: string;
  readonly initial: Draft;
  readonly onSent: (sent: Sent) => void;
  readonly onClose: () => void;
}) => {
  const call = useCall();
  const [draft, setDraft] = useState<Draft>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await call(
      api.send(accountId, {
        to: recipients(draft.to),
        cc: recipients(draft.cc),
        bcc: recipients(draft.bcc),
        subject: draft.subject,
        text: draft.text,
        html: "",
        inReplyTo: draft.inReplyTo,
        references: draft.references,
      }),
    );
    setPending(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    onSent(result.value);
  };

  return (
    <Card raised className="w-full">
      <CardHeader>
        <CardTitle>New message from {from}</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {FIELDS.map(({ field, label }) => (
            <div key={field} className="flex flex-col gap-1">
              <FieldLabel htmlFor={`compose-${field}`}>{label}</FieldLabel>
              <Input
                id={`compose-${field}`}
                value={draft[field]}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="compose-text">Message</FieldLabel>
            <textarea
              id="compose-text"
              rows={12}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              className="rounded-md border border-line bg-surface-sunken p-3 text-sm text-fg outline-none focus:border-line-strong focus:ring-2 focus:ring-ring/30"
            />
          </div>
          {error !== null && <Banner tone="danger">Could not send: {error}</Banner>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Discard
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
};
