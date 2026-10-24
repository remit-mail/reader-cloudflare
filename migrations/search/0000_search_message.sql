CREATE TABLE `search_message` (
	`fts_rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`account_id` text NOT NULL,
	`mailbox_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_message_message_id_unique` ON `search_message` (`message_id`);--> statement-breakpoint
CREATE INDEX `search_message_by_account_id` ON `search_message` (`account_id`,`mailbox_id`);