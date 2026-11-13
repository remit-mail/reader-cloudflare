-- The search index tokenizes words with unicode61, folding case and
-- diacritics, in place of trigrams, to match reader's SearchIndex (#1444).
-- The table is dropped and created again empty; sync indexes messages anew.
DROP TABLE IF EXISTS thread_message_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE thread_message_fts USING fts5(
	thread_message_id UNINDEXED,
	account_config_id UNINDEXED,
	mailbox_id UNINDEXED,
	sent_date UNINDEXED,
	list_id UNINDEXED,
	subject,
	sender,
	body,
	tokenize='unicode61 remove_diacritics 2'
);
