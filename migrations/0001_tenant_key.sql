CREATE TABLE `tenant_key` (
	`tenant_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`wrapped_key` blob NOT NULL,
	`iv` blob NOT NULL,
	PRIMARY KEY(`tenant_id`, `key_version`)
);
--> statement-breakpoint
DELETE FROM `credential` WHERE `key_version` = 0;
