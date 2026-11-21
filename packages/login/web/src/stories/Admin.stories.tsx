import type { UserSettingsResponse } from "@remit/api-openapi-types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ClassificationView } from "../../../../../src/operator-settings-contract";
import {
  type AdminUser,
  adminPage,
  auditPage,
  enrollPage,
  type Html,
  tenantClassificationForm,
  toResponse,
} from "../../../src/admin-page";
import loginCss from "../styles/login.css?url";

const meta: Meta = {
  title: "Playground/Proposed/Identity/Admin",
  render: (_args, { loaded }) => (
    <iframe title="Admin page" srcDoc={String(loaded.source)} className="h-dvh w-full border-0" />
  ),
};
export default meta;

type Story = StoryObj;

const OPERATOR = "operator@example.com";

const USERS: readonly AdminUser[] = [
  {
    userId: "operator-id",
    email: OPERATOR,
    state: "active",
    passkeys: 1,
    app: true,
    sessions: 2,
    lastSignIn: 1793990000000,
  },
  {
    userId: "person-1",
    email: "person1@example.com",
    state: "active",
    passkeys: 0,
    app: true,
    sessions: 1,
    lastSignIn: 1793900000000,
  },
  {
    userId: "person-2",
    email: "person2@example.com",
    state: "disabled",
    passkeys: 1,
    app: false,
    sessions: 0,
    lastSignIn: null,
  },
  {
    userId: null,
    email: "person3@example.com",
    state: "invited",
    passkeys: 0,
    app: false,
    sessions: 0,
    lastSignIn: null,
  },
];

const CLASSIFIER: ClassificationView = {
  state: "Configured",
  presets: [
    {
      presetId: "Mistral",
      label: "Mistral",
    },
  ],
  presetId: "Mistral",
  model: "ministral-8b-latest",
  baseUrl: "https://api.eu.mistral.ai/v1",
  dailyLimit: 500,
  enabled: true,
  hasKey: true,
  version: 3,
  updatedAt: 1793990000000,
  updatedBy: OPERATOR,
};

const TENANT_SETTINGS: UserSettingsResponse = {
  defaultInvitationSenderChosen: false,
  classificationPresets: [
    {
      presetId: "Mistral",
      label: "Mistral",
      group: "Hosted",
      adapterShape: "ChatJsonSchema",
      defaultBaseUrl: "https://api.eu.mistral.ai/v1",
      defaultModel: "ministral-8b-latest",
      needsKey: true,
      price: { state: "NoPrice" },
    },
  ],
  classification: {
    state: "Configured",
    presetId: "Mistral",
    model: "ministral-8b-latest",
    baseUrl: "https://api.eu.mistral.ai/v1",
    enabled: true,
    dailyLimit: 200,
    sources: {
      presetId: "Saved",
      model: "Default",
      baseUrl: "Default",
      apiKey: "Saved",
      enabled: "Saved",
      dailyLimit: "Saved",
    },
    usage: [],
  },
  spam: {
    thresholds: { state: "Unset" },
    spamPlacement: "MoveToSpam",
    phishingPlacement: "MoveToSpam",
  },
};

const load = (page: Html) => async () => {
  const parsed = new DOMParser().parseFromString(await toResponse(page).text(), "text/html");
  for (const link of parsed.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")) {
    link.href = loginCss;
  }
  for (const script of parsed.querySelectorAll("script")) script.remove();
  return { source: `<!doctype html>${parsed.documentElement.outerHTML}` };
};

export const People: Story = {
  loaders: [
    load(
      adminPage(
        OPERATOR,
        USERS,
        { ok: true, view: CLASSIFIER },
        [{ userId: "person-1", email: "person1@example.com" }],
        (email) => email === OPERATOR,
      ),
    ),
  ],
};

export const TenantClassifier: Story = {
  loaders: [
    load(
      tenantClassificationForm({
        ok: true,
        userId: "person-1",
        email: "person1@example.com",
        settings: TENANT_SETTINGS,
      }),
    ),
  ],
};

export const Enroll: Story = {
  loaders: [load(enrollPage())],
};

export const Audit: Story = {
  loaders: [
    load(
      auditPage(7, [
        {
          at: 1793990000000,
          actor: OPERATOR,
          email: "person1@example.com",
          address: "192.0.2.1",
          event: "Invite",
          outcome: "Succeeded",
          clientId: "",
        },
      ]),
    ),
  ],
};
