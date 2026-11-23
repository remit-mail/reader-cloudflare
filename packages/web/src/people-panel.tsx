import { ButtonLink } from "@remit/ui";
import { useEffect } from "react";

const ADMIN_URL = `${import.meta.env.VITE_LOGIN_ORIGIN}/admin`;

export const PeoplePanel = () => {
  useEffect(() => window.location.replace(ADMIN_URL), []);
  return <ButtonLink href={ADMIN_URL}>Manage people in login administration</ButtonLink>;
};
