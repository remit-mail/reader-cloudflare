import m0000 from "./0000_mail_db.sql";
import m0001 from "./0001_outbox.sql";
import m0002 from "./0002_sync_skip.sql";
import m0003 from "./0003_reader_mail.sql";
import m0004 from "./0004_drop_sync_skip.sql";
import m0005 from "./0005_thread_message_fts.sql";
import m0006 from "./0006_message_search_text.sql";
import m0007 from "./0007_unicode61_tokenizer.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
    m0007,
  },
};
