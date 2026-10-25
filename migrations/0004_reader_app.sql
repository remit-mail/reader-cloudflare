CREATE TABLE `account_export_request` (
	`account_export_request_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'Pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`object_key` text,
	`download_url` text,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `account_export_request_by_account_config_id` ON `account_export_request` (`account_config_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `calendar` (
	`calendar_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`url_segment` text NOT NULL,
	`display_name` text NOT NULL,
	`color` text DEFAULT 'Cal1' NOT NULL,
	`component_set` text DEFAULT 'VeventOnly' NOT NULL,
	`source` text DEFAULT 'UserCreated' NOT NULL,
	`timezone` text DEFAULT '' NOT NULL,
	`sync_sequence` integer DEFAULT 0 NOT NULL,
	`subscription_url` text DEFAULT '' NOT NULL,
	`subscription_enabled` integer DEFAULT false NOT NULL,
	`subscription_checked_at` integer DEFAULT 0 NOT NULL,
	`subscription_fetched_at` integer DEFAULT 0 NOT NULL,
	`subscription_error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `calendar_by_url_segment` ON `calendar` (`account_config_id`,`url_segment`);--> statement-breakpoint
CREATE INDEX `calendar_primary` ON `calendar` (`account_config_id`,`calendar_id`);--> statement-breakpoint
CREATE TABLE `calendar_event_index` (
	`calendar_id` text NOT NULL,
	`calendar_object_id` text NOT NULL,
	`recurrence_id` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Confirmed' NOT NULL,
	`transparency` text DEFAULT 'Opaque' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`calendar_id`, `calendar_object_id`, `recurrence_id`)
);
--> statement-breakpoint
CREATE INDEX `calendar_event_index_by_start` ON `calendar_event_index` (`calendar_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `calendar_feed_token` (
	`feed_token_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_config_id`, `feed_token_id`)
);
--> statement-breakpoint
CREATE INDEX `calendar_feed_token_by_token_hash` ON `calendar_feed_token` (`token_hash`);--> statement-breakpoint
CREATE TABLE `calendar_object` (
	`calendar_object_id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`ical_uid` text NOT NULL,
	`ical_data` text NOT NULL,
	`etag` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`sync_sequence` integer DEFAULT 0 NOT NULL,
	`summary` text NOT NULL,
	`dt_start` text NOT NULL,
	`dt_end` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`zone_certainty` text DEFAULT 'Explicit' NOT NULL,
	`status` text DEFAULT 'Confirmed' NOT NULL,
	`transparency` text DEFAULT 'Opaque' NOT NULL,
	`has_recurrence` integer DEFAULT false NOT NULL,
	`expanded_through` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `calendar_object_by_sync_sequence` ON `calendar_object` (`calendar_id`,`sync_sequence`);--> statement-breakpoint
CREATE INDEX `calendar_object_by_uid` ON `calendar_object` (`calendar_id`,`ical_uid`);--> statement-breakpoint
CREATE INDEX `calendar_object_primary` ON `calendar_object` (`calendar_id`,`calendar_object_id`);