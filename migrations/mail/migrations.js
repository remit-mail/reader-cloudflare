import m0000 from "./20261024144301_mail_db/migration.sql";
import m0001 from "./20261024192105_outbox/migration.sql";
import m0002 from "./20261024211605_sync_skip/migration.sql";
import m0003 from "./20261025111257_reader_mail/migration.sql";
import m0004 from "./20261025111315_drop_sync_skip/migration.sql";
import m0005 from "./20261025111317_thread_message_fts/migration.sql";
import m0006 from "./20261025201957_message_search_text/migration.sql";
import m0007 from "./20261025201958_unicode61_tokenizer/migration.sql";
import m0008 from "./20261029073238_message_by_body_storage_key/migration.sql";
import m0009 from "./20261029090302_drop_body_part_storage/migration.sql";
import m0010 from "./20261029091723_thread_message_deleted_means_expunge/migration.sql";
import m0011 from "./20261103182519_outbox_scheduling_part/migration.sql";
import m0012 from "./20261110212813_thread_message_tenant_indexes/migration.sql";
import m0013 from "./20261111043214_message_by_mailbox_internal_date/migration.sql";
import m0014 from "./20261113121752_classifier_scores_organize_rule/migration.sql";

export default {
  migrations: {
    "20261024144301_mail_db": m0000,
    "20261024192105_outbox": m0001,
    "20261024211605_sync_skip": m0002,
    "20261025111257_reader_mail": m0003,
    "20261025111315_drop_sync_skip": m0004,
    "20261025111317_thread_message_fts": m0005,
    "20261025201957_message_search_text": m0006,
    "20261025201958_unicode61_tokenizer": m0007,
    "20261029073238_message_by_body_storage_key": m0008,
    "20261029090302_drop_body_part_storage": m0009,
    "20261029091723_thread_message_deleted_means_expunge": m0010,
    "20261103182519_outbox_scheduling_part": m0011,
    "20261110212813_thread_message_tenant_indexes": m0012,
    "20261111043214_message_by_mailbox_internal_date": m0013,
    "20261113121752_classifier_scores_organize_rule": m0014,
  },
};
