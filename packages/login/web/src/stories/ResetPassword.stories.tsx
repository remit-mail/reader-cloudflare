import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type ResetPasswordState,
  ResetPasswordView,
  type ResetRequestState,
  ResetRequestView,
} from "../pages/Reset";
import { hold, noop } from "./fixtures";

const meta: Meta = { title: "Playground/Proposed/Identity/Reset password" };
export default meta;

type Story = StoryObj;

const Request = ({ state }: { state: ResetRequestState }) => (
  <ResetRequestView state={state} busy={false} onRequest={hold} onResend={noop} />
);

const SetPassword = ({ state }: { state: ResetPasswordState }) => (
  <ResetPasswordView
    state={state}
    opening={null}
    busy={false}
    onSubmit={hold}
    onFresh={noop}
    onRetryOpen={noop}
  />
);

export const EnterEmail: Story = {
  render: () => <Request state={{ kind: "email", failure: null }} />,
};

export const LinkSent: Story = {
  render: () => <Request state={{ kind: "sent", email: "user@example.com" }} />,
};

export const SetNewPassword: Story = {
  render: () => <SetPassword state={{ kind: "ready", email: "user@example.com", problem: null }} />,
};

export const PasswordRefused: Story = {
  render: () => (
    <SetPassword
      state={{
        kind: "ready",
        email: "user@example.com",
        problem: {
          kind: "field",
          message:
            "This password is in a list of leaked passwords. Pick one you have never used anywhere else.",
        },
      }}
    />
  ),
};

export const LinkExpired: Story = {
  render: () => <SetPassword state={{ kind: "expired", failure: null }} />,
};

export const FreshLinkSent: Story = {
  render: () => <SetPassword state={{ kind: "fresh-sent" }} />,
};

export const LinkMissing: Story = {
  render: () => <SetPassword state={{ kind: "missing" }} />,
};
