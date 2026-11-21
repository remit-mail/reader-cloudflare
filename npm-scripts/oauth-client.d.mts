export declare const oauthClientUpsertSql: (row: {
  readonly clientId: string;
  readonly secretHash: string;
  readonly redirectUri: string;
  readonly now: number;
}) => string;
