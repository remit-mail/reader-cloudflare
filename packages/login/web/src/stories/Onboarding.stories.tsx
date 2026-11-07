import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Opening } from "../flow";
import {
  AppSetupView,
  BackupCodesView,
  type OnboardingStep,
  WelcomeSecondStepView,
} from "../pages/Invite";
import { CODES, hold, noop, TOTP_URI } from "./fixtures";

const meta: Meta = { title: "Playground/Proposed/Identity/Onboarding" };
export default meta;

type Story = StoryObj;

const Step = ({ step, passkeys = true }: { step: OnboardingStep; passkeys?: boolean }) => (
  <WelcomeSecondStepView
    step={step}
    passkeys={passkeys}
    busy={false}
    opening={null}
    onConfirm={hold}
    onPasskey={noop}
    onApp={noop}
    onChoose={noop}
    onSkip={noop}
    app={null}
  />
);

const App = ({ error }: { error: string | null }) => (
  <WelcomeSecondStepView
    step={{ kind: "app" }}
    passkeys
    busy={false}
    opening={null}
    onConfirm={hold}
    onPasskey={noop}
    onApp={noop}
    onChoose={noop}
    onSkip={noop}
    app={
      <AppSetupView
        state={{ kind: "scan", uri: TOTP_URI, codes: CODES, error }}
        busy={false}
        onVerify={hold}
        onRetry={noop}
        onBack={noop}
      />
    }
  />
);

export const ConfirmAgain: Story = {
  render: () => <Step step={{ kind: "confirm-again", resume: "app", error: null }} />,
};

export const Choose: Story = {
  render: () => <Step step={{ kind: "choose" }} />,
};

export const NoPasskeySupport: Story = {
  render: () => <Step step={{ kind: "choose" }} passkeys={false} />,
};

export const PasskeyPrompt: Story = {
  render: () => <Step step={{ kind: "passkey-waiting" }} />,
};

export const PasskeyFailed: Story = {
  render: () => (
    <Step
      step={{ kind: "passkey-failed", message: "The operation was aborted.", cancelled: true }}
    />
  ),
};

export const AppScan: Story = {
  render: () => <App error={null} />,
};

export const AppCodeWrong: Story = {
  render: () => (
    <App error="That code did not match. The code changes every 30 seconds. Type the newest one." />
  ),
};

const OpeningStep = ({ opening }: { opening: Opening }) => (
  <WelcomeSecondStepView
    step={{ kind: "choose" }}
    passkeys
    busy={false}
    opening={opening}
    onConfirm={hold}
    onPasskey={noop}
    onApp={noop}
    onChoose={noop}
    onSkip={noop}
    app={null}
  />
);

export const OpeningRemit: Story = {
  render: () => <OpeningStep opening={{ kind: "opening" }} />,
};

export const OpeningRemitFailed: Story = {
  render: () => (
    <OpeningStep
      opening={{
        kind: "failed",
        message: "GET /app/config did not name the reader origin: The login site answered 503.",
      }}
    />
  ),
};

export const BackupCodes: Story = {
  render: () => <BackupCodesView codes={CODES} onDone={noop} />,
};
