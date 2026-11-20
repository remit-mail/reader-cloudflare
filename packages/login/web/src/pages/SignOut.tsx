import { Button } from "@remit/ui/auth";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FAILURE_EVENT, leave, post } from "../api";
import { Page, Text } from "../ui";

const fail = (detail: string): void => {
  window.dispatchEvent(new CustomEvent(FAILURE_EVENT, { detail }));
};

export const useSignOut = (path: string) => {
  const [busy, setBusy] = useState(false);
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    void post(path).then(async (answer) => {
      const failure = answer.ok ? await leave(answer) : answer.message;
      if (failure === null) return;
      setBusy(false);
      fail(failure);
    });
  };
  return { busy, onSubmit };
};

export const SignOut = () => {
  const { busy, onSubmit } = useSignOut("/app/sign-out");
  const form = useRef<HTMLFormElement>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    form.current?.requestSubmit();
  }, []);
  return (
    <Page title="Sign out of remit">
      <form ref={form} onSubmit={onSubmit} className="flex flex-col gap-4">
        <Text>{busy ? "Signing you out…" : "This ends your session on this device."}</Text>
        <Button type="submit" className="w-full" disabled={busy}>
          Sign out
        </Button>
      </form>
    </Page>
  );
};
