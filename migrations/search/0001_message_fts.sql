CREATE VIRTUAL TABLE `message_fts` USING fts5(
	message_id UNINDEXED,
	account_id UNINDEXED,
	mailbox_id UNINDEXED,
	subject,
	from_text,
	to_text,
	body_text,
	tokenize = 'unicode61 remove_diacritics 2'
);
