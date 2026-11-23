import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type Account,
  type SecurityDialog,
  type SecurityFailure,
  SecurityView,
} from "../pages/Security";
import { CODES, hold, noop } from "./fixtures";

const meta: Meta = { title: "Playground/Proposed/Identity/Security settings" };
export default meta;

type Story = StoryObj;

const ACCOUNT: Account = {
  email: "user@example.com",
  app: true,
  passkeys: [
    { id: "passkey-1", name: "Laptop" },
    { id: "passkey-2", name: "Phone" },
  ],
};

const View = ({
  account = ACCOUNT,
  passkeys = true,
  dialog = null,
  failure = null,
}: {
  account?: Account;
  passkeys?: boolean;
  dialog?: SecurityDialog | null;
  failure?: SecurityFailure | null;
}) => (
  <SecurityView
    account={account}
    passkeys={passkeys}
    notice={null}
    failure={failure}
    dialog={dialog}
    busy={false}
    onOpen={noop}
    onClose={noop}
    onSignOutEverywhere={noop}
    onRemovePasskey={noop}
    onAddPasskey={noop}
    onChangePassword={hold}
    onNewCodes={noop}
    onTurnOff={noop}
    addApp={null}
    mailSecurityUrl="http://localhost:8790/settings/security"
  />
);

export const Overview: Story = {
  render: () => <View />,
};

export const NewBackupCodes: Story = {
  render: () => <View dialog={{ kind: "codes", codes: CODES }} />,
};

export const NoPasskeySupport: Story = {
  render: () => <View account={{ ...ACCOUNT, app: false }} passkeys={false} />,
};

export const ActionFailed: Story = {
  render: () => (
    <View
      failure={{
        title: "The passkey was not removed",
        message: "The login site answered 500.",
      }}
    />
  ),
};
