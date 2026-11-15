import { Button } from "@remit/ui/auth";
import { signOutVia } from "../api";
import { Page, Text } from "../ui";

export const SignOut = () => (
  <Page title="Sign out of remit">
    <form onSubmit={signOutVia("/app/sign-out")} className="flex flex-col gap-4">
      <Text>This ends your session on this device.</Text>
      <Button type="submit" className="w-full">
        Sign out
      </Button>
    </form>
  </Page>
);
