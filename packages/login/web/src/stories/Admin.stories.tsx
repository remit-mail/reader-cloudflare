import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type AdminUser,
  adminPage,
  auditPage,
  enrollPage,
  type Html,
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
    email: OPERATOR,
    state: "active",
    passkeys: 1,
    app: true,
    sessions: 2,
    lastSignIn: 1793990000000,
  },
  {
    email: "person1@example.com",
    state: "active",
    passkeys: 0,
    app: true,
    sessions: 1,
    lastSignIn: 1793900000000,
  },
  {
    email: "person2@example.com",
    state: "disabled",
    passkeys: 1,
    app: false,
    sessions: 0,
    lastSignIn: null,
  },
  {
    email: "person3@example.com",
    state: "invited",
    passkeys: 0,
    app: false,
    sessions: 0,
    lastSignIn: null,
  },
];

const load = (page: Html) => async () => ({
  source: (await toResponse(page).text())
    .replace('href="/login.css"', `href="${loginCss}"`)
    .replace('<script type="module" src="/admin.js"></script>', ""),
});

export const People: Story = {
  loaders: [load(adminPage(OPERATOR, USERS, (email) => email === OPERATOR))],
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
