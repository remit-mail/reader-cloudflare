import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  type SecondStepMethod,
  type SecondStepProblem,
  SecondStepView,
  type SignInProblem,
  SignInView,
} from "../pages/SignIn";
import { hold, noop } from "./fixtures";

const meta: Meta = { title: "Playground/Proposed/Identity/Sign in" };
export default meta;

type Story = StoryObj;

const First = ({ problem }: { problem: SignInProblem | null }) => (
  <SignInView
    problem={problem}
    busy={false}
    passkeys
    onSubmit={hold}
    onPasskey={noop}
    onUsePassword={noop}
  />
);

const Second = ({
  method,
  problem = null,
  busy = false,
}: {
  method: SecondStepMethod;
  problem?: SecondStepProblem | null;
  busy?: boolean;
}) => {
  const [current, setCurrent] = useState(method);
  return (
    <SecondStepView
      method={current}
      problem={problem}
      busy={busy}
      onSubmit={hold}
      onPasskey={noop}
      onMethod={setCurrent}
    />
  );
};

export const Idle: Story = {
  render: () => <First problem={null} />,
};

export const WrongPassword: Story = {
  render: () => <First problem={{ kind: "wrong" }} />,
};

export const Locked: Story = {
  render: () => (
    <First
      problem={{
        kind: "locked",
        message: "Too many attempts. Try again later. Try again after 14:35:00.",
        retryAt: Date.now() + 15 * 60 * 1000,
      }}
    />
  ),
};

export const Disabled: Story = {
  render: () => <First problem={{ kind: "disabled" }} />,
};

export const PasskeyFailed: Story = {
  render: () => <First problem={{ kind: "passkey-cancelled" }} />,
};

export const ServerError: Story = {
  render: () => <First problem={{ kind: "server", message: "The login site answered 500." }} />,
};

export const PasskeyStep: Story = {
  render: () => <Second method="passkey" />,
};

export const PasskeyStepPrompt: Story = {
  render: () => <Second method="passkey" busy />,
};

export const PasskeyStepCancelled: Story = {
  render: () => <Second method="passkey" problem={{ kind: "passkey-cancelled" }} />,
};

export const PasskeyStepFailed: Story = {
  render: () => <Second method="passkey" problem={{ kind: "passkey-other-account" }} />,
};

export const PasskeyStepExpired: Story = {
  render: () => <Second method="passkey" problem={{ kind: "expired" }} />,
};

export const SecondStep: Story = {
  render: () => <Second method="app" />,
};

export const BackupCode: Story = {
  render: () => <Second method="backup" />,
};

export const NoAppNoCodes: Story = {
  render: () => <Second method="help" />,
};
