import type { ReactNode } from "react";
import { reportUrl } from "./api";

export const Page = ({ title, children }: { title: string; children: ReactNode }) => (
  <main className="page">
    <header className="brand">
      <span className="mark">remit</span>
    </header>
    <section className="card">
      <h1>{title}</h1>
      {children}
    </section>
  </main>
);

export const Failure = ({ message }: { message: string | null }) =>
  message === null ? null : (
    <div className="banner danger" role="alert">
      <p>{message}</p>
      <p>
        <a href={reportUrl(message)} target="_blank" rel="noreferrer">
          Report an issue
        </a>
      </p>
    </div>
  );

export const Notice = ({ children }: { children: ReactNode }) => (
  <div className="banner ok" role="status">
    {children}
  </div>
);

export const Field = ({
  id,
  label,
  ...input
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <div>
    <label htmlFor={id}>{label}</label>
    <input id={id} name={id} {...input} />
  </div>
);
