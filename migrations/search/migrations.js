import m0000 from "./0000_search_message.sql";
import m0001 from "./0001_message_fts.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
