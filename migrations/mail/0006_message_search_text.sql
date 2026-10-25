CREATE TABLE `message_search_text` (
	`message_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `address_by_normalized_email` ON `address` (`account_config_id`,`normalized_email`);