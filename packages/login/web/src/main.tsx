import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BackupCodes, Invite, WelcomePassword, WelcomeSecondStep } from "./pages/Invite";
import { Reset } from "./pages/Reset";
import { Security } from "./pages/Security";
import { SecondStep, SignIn } from "./pages/SignIn";
import { SignOut } from "./pages/SignOut";

const PAGES: Readonly<Record<string, () => ReactNode>> = {
  "/sign-in": () => <SignIn />,
  "/sign-in/second-step": () => <SecondStep />,
  "/invite": () => <Invite />,
  "/welcome/password": () => <WelcomePassword />,
  "/welcome/second-step": () => <WelcomeSecondStep />,
  "/welcome/backup-codes": () => <BackupCodes />,
  "/reset": () => <Reset />,
  "/security": () => <Security />,
  "/sign-out": () => <SignOut />,
};

const App = () => {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const page = PAGES[path] ?? PAGES["/sign-in"];
  return <>{page?.()}</>;
};

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
