import PostalMime, { type Email, type RawEmail } from "postal-mime";

export const parseEmail = (raw: RawEmail): Promise<Email> =>
  PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
