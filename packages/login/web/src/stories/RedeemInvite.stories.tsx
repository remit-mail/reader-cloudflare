import type { Meta, StoryObj } from "@storybook/react-vite";
import { InviteView, WelcomePasswordView } from "../pages/Invite";
import { hold, noop } from "./fixtures";

const meta: Meta = { title: "Playground/Proposed/Identity/Redeem invite" };
export default meta;

type Story = StoryObj;

export const Ready: Story = {
  render: () => (
    <InviteView
      state={{ kind: "ready", email: "invitee@example.com", failure: null }}
      busy={false}
      onContinue={noop}
    />
  ),
};

export const SetPassword: Story = {
  render: () => (
    <WelcomePasswordView email="invitee@example.com" problem={null} busy={false} onSubmit={hold} />
  ),
};

export const PasswordRefused: Story = {
  render: () => (
    <WelcomePasswordView
      email="invitee@example.com"
      problem={{
        kind: "field",
        message:
          "This password is in a list of leaked passwords. Pick one you have never used anywhere else.",
      }}
      busy={false}
      onSubmit={hold}
    />
  ),
};

export const PasswordCheckFailed: Story = {
  render: () => (
    <WelcomePasswordView
      email="invitee@example.com"
      problem={{ kind: "check-failed", message: "The login site answered 503." }}
      busy={false}
      onSubmit={hold}
    />
  ),
};

export const NoLongerWorks: Story = {
  render: () => <InviteView state={{ kind: "expired" }} busy={false} onContinue={noop} />,
};

export const Locked: Story = {
  render: () => (
    <InviteView
      state={{
        kind: "locked",
        message: "Too many attempts. Try again later. Try again after 14:35:00.",
      }}
      busy={false}
      onContinue={noop}
    />
  ),
};
