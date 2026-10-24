export interface SearchDocument {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly bodyText: string;
}

export interface SearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly mailboxId: string | null;
}

export interface SearchHit {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly rank: number;
}
