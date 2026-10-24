import { AddressRole } from "@remit/domain-enums";
import {
  AddressList,
  Banner,
  Button,
  createEmailSanitizer,
  type EnvelopeAddress,
  MessageListLoading,
} from "@remit/ui";
import { useMemo } from "react";
import { api, type Message, type MessageBody } from "./api";
import { fullDate } from "./format";
import { useCall } from "./session";
import { useLoad } from "./use-load";

const sanitize = createEmailSanitizer({ allowExternalImages: false });

const addressesFor = (message: Message, role: string): EnvelopeAddress[] =>
  message.addresses
    .filter((address) => address.role === role)
    .sort((a, b) => a.order - b.order)
    .map((address) =>
      address.name === null || address.name === ""
        ? { normalizedEmail: address.email }
        : { displayName: address.name, normalizedEmail: address.email },
    );

const HtmlBody = ({ html }: { readonly html: string }) => {
  const srcDoc = useMemo(() => sanitize(html).html, [html]);
  return (
    <iframe
      title="Message body"
      sandbox=""
      srcDoc={srcDoc}
      className="h-[70vh] w-full rounded-md border border-line bg-white"
    />
  );
};

const Body = ({ body }: { readonly body: MessageBody }) => (
  <div className="flex flex-col gap-3">
    {body.html !== "" ? (
      <HtmlBody html={body.html} />
    ) : (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm text-fg">{body.text}</pre>
    )}
    {body.attachments.length > 0 && (
      <ul className="flex flex-col gap-1 text-sm text-fg-muted">
        {body.attachments.map((attachment) => (
          <li key={`${attachment.filename}:${attachment.mimeType}:${attachment.size}`}>
            {attachment.filename === "" ? "(unnamed attachment)" : attachment.filename} —{" "}
            {attachment.mimeType}, {Math.ceil(attachment.size / 1024)} KB
          </li>
        ))}
      </ul>
    )}
  </div>
);

export interface Loaded {
  readonly message: Message;
  readonly body: MessageBody;
}

export const MessageView = ({
  accountId,
  messageId,
  onReply,
}: {
  readonly accountId: string;
  readonly messageId: string;
  readonly onReply: (loaded: Loaded) => void;
}) => {
  const call = useCall();
  const [message, reloadMessage] = useLoad(
    () => call(api.message(accountId, messageId)),
    `${accountId}/${messageId}`,
  );
  const [body, reloadBody] = useLoad(
    () => call(api.body(accountId, messageId)),
    `${accountId}/${messageId}`,
  );

  if (message.kind === "loading") return <MessageListLoading />;
  if (message.kind === "failed") {
    return (
      <Banner tone="danger" className="m-4">
        Could not open the message: {message.reason}{" "}
        <Button size="sm" variant="secondary" onClick={reloadMessage}>
          Retry
        </Button>
      </Banner>
    );
  }
  const value = message.value;
  return (
    <article className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-fg">{value.subject ?? "(no subject)"}</h2>
          <Button
            size="sm"
            variant="secondary"
            disabled={body.kind !== "ready"}
            onClick={() => {
              if (body.kind === "ready") onReply({ message: value, body: body.value });
            }}
          >
            Reply
          </Button>
        </div>
        <AddressList label="From" addresses={addressesFor(value, AddressRole.From)} />
        <AddressList label="To" addresses={addressesFor(value, AddressRole.To)} />
        <AddressList label="Cc" addresses={addressesFor(value, AddressRole.Cc)} />
        <p className="text-xs text-fg-muted">{fullDate(value.date)}</p>
      </header>
      {body.kind === "loading" && <MessageListLoading />}
      {body.kind === "failed" && (
        <Banner tone="danger">
          Could not load the message body: {body.reason}{" "}
          <Button size="sm" variant="secondary" onClick={reloadBody}>
            Retry
          </Button>
        </Banner>
      )}
      {body.kind === "ready" && <Body body={body.value} />}
    </article>
  );
};
