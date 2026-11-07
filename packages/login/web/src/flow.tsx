import { Button, ButtonLink } from "@remit/ui";
import { useState } from "react";
import { leave } from "./api";
import { focusOnMount, Muted, Notice, Page, ReportLink, Text } from "./ui";

export type Opening =
  | { readonly kind: "opening" }
  | { readonly kind: "failed"; readonly message: string };

export const OpeningRemitView = ({
  opening,
  onRetry,
}: {
  opening: Opening;
  onRetry: () => void;
}) =>
  opening.kind === "opening" ? (
    <Page title="Opening remit" focusTitle>
      <Muted>You are signed in. Your mail opens in a moment.</Muted>
    </Page>
  ) : (
    <Page title="remit did not open">
      <Notice tone="danger" title="remit did not open" report={opening.message}>
        {opening.message} You are still signed in.
      </Notice>
      <Button ref={focusOnMount} onClick={onRetry} className="w-full">
        Try again
      </Button>
    </Page>
  );

export const useOpenRemit = (): {
  readonly opening: Opening | null;
  readonly open: () => Promise<void>;
} => {
  const [opening, setOpening] = useState<Opening | null>(null);
  const open = async () => {
    setOpening({ kind: "opening" });
    const failure = await leave({ ok: true, status: 200, body: {} });
    if (failure !== null) setOpening({ kind: "failed", message: failure });
  };
  return { opening, open };
};

export type LinkKind = "invite" | "reset";

export const LinkExpiredView = ({
  kind,
  busy,
  failure,
  onFresh,
}: {
  kind: LinkKind;
  busy: boolean;
  failure: string | null;
  onFresh: () => void;
}) => (
  <Page title={kind === "invite" ? "This invite has expired" : "This link has expired"}>
    {failure === null ? null : (
      <Notice tone="danger" title="No fresh link was sent" report={failure}>
        {failure} Try again in a minute.
      </Notice>
    )}
    <Text>
      {kind === "invite"
        ? "An invite works once and for 7 days. A newer invite also replaces an older one."
        : "A reset link works once and for 1 hour. A newer link also replaces an older one."}
    </Text>
    <Button ref={focusOnMount} onClick={onFresh} disabled={busy} className="w-full">
      {kind === "invite" ? "Email me a fresh invite" : "Email me a fresh link"}
    </Button>
    <ButtonLink variant="secondary" href="/sign-in">
      {kind === "invite" ? "Already have an account? Sign in" : "Back to sign-in"}
    </ButtonLink>
  </Page>
);

export const FreshLinkSentView = ({ kind }: { kind: LinkKind }) => (
  <Page title="Check your email" focusTitle>
    <Notice
      title={kind === "invite" ? "A fresh invite is on its way" : "A fresh link is on its way"}
    >
      If this link can be renewed, we sent a new one to the address it was sent to. The old link no
      longer works. Look in spam too.
    </Notice>
    <p className="text-sm text-fg-muted">
      Nothing after a few minutes? <ReportLink detail="The fresh link email did not arrive." />
    </p>
  </Page>
);

export const LinkMissingView = ({ kind }: { kind: LinkKind }) => (
  <Page title="Open the link from your email" focusTitle>
    <Text>
      This page needs the link from your email, and it can only read it once. Open the email and
      press the link again.
    </Text>
    {kind === "reset" ? <ButtonLink href="/reset">Send a new reset link</ButtonLink> : null}
    <ButtonLink variant="secondary" href="/sign-in">
      Back to sign-in
    </ButtonLink>
  </Page>
);
