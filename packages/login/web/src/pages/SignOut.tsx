import { Page } from "../ui";

export const SignOut = () => (
  <Page title="Sign out of remit">
    <form method="post" action="/app/sign-out">
      <p>This ends your session on this device.</p>
      <button type="submit" className="button primary">
        Sign out
      </button>
    </form>
  </Page>
);
