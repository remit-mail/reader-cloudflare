import { type ImapCredential, openImap } from "./imap-connect";
import type { FlagChange, MessageLocation } from "./types";

const SEEN = "\\Seen";
const FLAGGED = "\\Flagged";

const byMailbox = (locations: readonly MessageLocation[]): Map<string, number[]> => {
  const groups = new Map<string, number[]>();
  for (const location of locations) {
    groups.set(location.mailboxPath, [...(groups.get(location.mailboxPath) ?? []), location.uid]);
  }
  return groups;
};

const changes = (change: FlagChange): { flag: string; set: boolean }[] => [
  ...(change.isRead === null ? [] : [{ flag: SEEN, set: change.isRead }]),
  ...(change.isStarred === null ? [] : [{ flag: FLAGGED, set: change.isStarred }]),
];

export const pushFlags = async (
  credential: ImapCredential,
  locations: readonly MessageLocation[],
  change: FlagChange,
): Promise<void> => {
  const client = await openImap(credential);
  try {
    for (const [path, uids] of byMailbox(locations)) {
      const lock = await client.getMailboxLock(path);
      try {
        const range = uids.join(",");
        for (const { flag, set } of changes(change)) {
          const applied = set
            ? await client.messageFlagsAdd(range, [flag], { uid: true })
            : await client.messageFlagsRemove(range, [flag], { uid: true });
          if (!applied) throw new Error(`${path} refused ${set ? "adding" : "removing"} ${flag}`);
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    client.close();
  }
};
