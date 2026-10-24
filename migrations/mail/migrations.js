import m0000 from "./0000_mail_db.sql";
import m0001 from "./0001_outbox.sql";
import journal from "./meta/_journal.json";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
