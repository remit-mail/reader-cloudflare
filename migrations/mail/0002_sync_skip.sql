CREATE TABLE `sync_skip` (
	`mailbox_id` text NOT NULL,
	`uid` integer NOT NULL,
	`object_key` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `uid`)
);
