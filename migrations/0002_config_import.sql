CREATE TABLE `config_import` (
	`import_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`state` text DEFAULT 'Pending' NOT NULL,
	`document` text NOT NULL,
	`unresolved_refs` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `config_import_by_account_config_id` ON `config_import` (`account_config_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `filter_anchor` (
	`account_config_id` text NOT NULL,
	`filter_id` text NOT NULL,
	`anchor_embedding` text NOT NULL,
	`anchor_embedding_id` text NOT NULL,
	`anchor_source_text` text NOT NULL,
	`anchor_message_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_config_id`, `filter_id`)
);
