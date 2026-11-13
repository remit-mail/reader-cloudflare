CREATE VIRTUAL TABLE IF NOT EXISTS thread_message_fts USING fts5(
	thread_message_id UNINDEXED,
	account_config_id UNINDEXED,
	mailbox_id UNINDEXED,
	sent_date UNINDEXED,
	list_id UNINDEXED,
	subject,
	sender,
	body,
	tokenize='trigram remove_diacritics 1'
);
