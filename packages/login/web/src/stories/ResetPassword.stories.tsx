import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ResetState, ResetView } from "../pages/Reset";
import { hold, noop } from "./fixtures";

const meta: Meta = { title: "Playground/Proposed/Identity/Reset password" };
export default meta;

type Story = StoryObj;

const View = ({ state }: { state: ResetState }) => (
  <ResetView state={state} busy={false} onRequest={hold} onReset={hold} onResend={noop} />
);

export const EnterEmail: Story = {
  render: () => <View state={{ kind: "email", failure: null }} />,
};

export const EnterCode: Story = {
  render: () => <View state={{ kind: "code", email: "user@example.com", problem: null }} />,
};

export const CodeWrong: Story = {
  render: () => (
    <View
      state={{
        kind: "code",
        email: "user@example.com",
        problem: {
          kind: "code",
          message:
            "That code is wrong or too old. A code works for 10 minutes. Send a new code if it has been longer.",
        },
      }}
    />
  ),
};

export const Done: Story = {
  render: () => <View state={{ kind: "done" }} />,
};
