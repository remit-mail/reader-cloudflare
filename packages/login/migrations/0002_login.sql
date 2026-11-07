CREATE TABLE `reset_link` (
	`reset_link_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state_changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reset_link_user` ON `reset_link` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reset_link_token_hash` ON `reset_link` (`token_hash`);--> statement-breakpoint
ALTER TABLE `invite` ADD `first_issued_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `invite` SET `first_issued_at` = `created_at`;
