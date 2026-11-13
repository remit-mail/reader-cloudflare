CREATE TABLE `body_part_parameter` (
	`body_part_parameter_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`body_part_id` text NOT NULL,
	`parameter_name` text NOT NULL,
	`parameter_value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `body_part_parameter_by_message_id` ON `body_part_parameter` (`message_id`,`body_part_parameter_id`);--> statement-breakpoint
CREATE TABLE `body_part_storage` (
	`body_part_storage_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`body_part_id` text NOT NULL,
	`storage_type` text NOT NULL,
	`storage_location` text NOT NULL,
	`storage_key` text NOT NULL,
	`decoded_size_bytes` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`content_encoding` text NOT NULL,
	`is_deduped` integer NOT NULL,
	`dedup_hash` text,
	`stored_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `body_part_storage_by_message_id` ON `body_part_storage` (`message_id`,`body_part_storage_id`);--> statement-breakpoint
CREATE TABLE `body_part` (
	`body_part_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`parent_body_part_id` text,
	`part_path` text NOT NULL,
	`media_type` text NOT NULL,
	`media_subtype` text NOT NULL,
	`content_id` text,
	`content_description` text,
	`transfer_encoding` text NOT NULL,
	`size_octets` integer NOT NULL,
	`line_count` integer,
	`md5_hash` text,
	`disposition` text,
	`disposition_filename` text,
	`language` text,
	`location` text,
	`is_multipart` integer NOT NULL,
	`multipart_subtype` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `body_part_by_message_id` ON `body_part` (`message_id`,`body_part_id`);--> statement-breakpoint
CREATE TABLE `body_structure_refetch` (
	`message_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_suggestion` (
	`suggestion_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`message_id` text NOT NULL,
	`body_part_id` text NOT NULL,
	`ical_uid` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`method` text DEFAULT 'None' NOT NULL,
	`source` text DEFAULT 'IcalendarPart' NOT NULL,
	`state` text DEFAULT 'Pending' NOT NULL,
	`summary` text NOT NULL,
	`dt_start` text NOT NULL,
	`dt_end` text NOT NULL,
	`ends_at_utc` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`organizer` text DEFAULT '' NOT NULL,
	`zone_certainty` text DEFAULT 'Explicit' NOT NULL,
	`ical_data` text DEFAULT '' NOT NULL,
	`accepted_calendar_object_id` text DEFAULT '' NOT NULL,
	`superseded_by_message_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_config_id`, `suggestion_id`)
);
--> statement-breakpoint
CREATE INDEX `calendar_suggestion_by_state` ON `calendar_suggestion` (`account_config_id`,`state`,`created_at`,`suggestion_id`);--> statement-breakpoint
CREATE INDEX `calendar_suggestion_by_message` ON `calendar_suggestion` (`account_config_id`,`message_id`,`suggestion_id`);--> statement-breakpoint
CREATE INDEX `calendar_suggestion_by_accepted_calendar_object` ON `calendar_suggestion` (`account_config_id`,`accepted_calendar_object_id`);--> statement-breakpoint
CREATE TABLE `mailbox_attribute_entry` (
	`mailbox_attribute_id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`attribute_name` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_attribute_entry_by_mailbox_id` ON `mailbox_attribute_entry` (`mailbox_id`,`mailbox_attribute_id`);--> statement-breakpoint
CREATE TABLE `mailbox_flag` (
	`mailbox_flag_id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`flag_name` text NOT NULL,
	`is_permanent` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_flag_by_mailbox_id` ON `mailbox_flag` (`mailbox_id`,`mailbox_flag_id`);--> statement-breakpoint
CREATE TABLE `mailbox_lock` (
	`mailbox_id` text NOT NULL,
	`event_name` text NOT NULL,
	`account_id` text NOT NULL,
	`lock_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`locked_by` text NOT NULL,
	`ttl` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `event_name`)
);
--> statement-breakpoint
CREATE INDEX `mailbox_lock_all_locks` ON `mailbox_lock` (`acquired_at`);--> statement-breakpoint
CREATE INDEX `mailbox_lock_by_account_id` ON `mailbox_lock` (`account_id`,`mailbox_id`,`event_name`);--> statement-breakpoint
CREATE TABLE `message_flag_push` (
	`message_id` text NOT NULL,
	`flag_name` text NOT NULL,
	`account_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`operation` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `flag_name`)
);
--> statement-breakpoint
CREATE INDEX `message_flag_push_by_mailbox_id` ON `message_flag_push` (`mailbox_id`,`message_id`,`flag_name`);--> statement-breakpoint
CREATE INDEX `message_flag_push_by_account_id` ON `message_flag_push` (`account_id`,`message_id`,`flag_name`);--> statement-breakpoint
CREATE TABLE `message_label` (
	`message_label_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`label_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`applied_by_filter_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_label_by_label_id` ON `message_label` (`account_config_id`,`label_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_label_by_message_id` ON `message_label` (`message_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `message_placement_move` (
	`message_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`source_mailbox_id` text NOT NULL,
	`destination_mailbox_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_placement_move_by_account_id` ON `message_placement_move` (`account_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `message_reference` (
	`message_reference_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`message_id_value` text NOT NULL,
	`reference_type` text NOT NULL,
	`reference_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_reference_by_message_id` ON `message_reference` (`message_id`,`message_reference_id`);--> statement-breakpoint
CREATE TABLE `organize_job_request` (
	`organize_job_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'Pending' NOT NULL,
	`filter_id` text DEFAULT 'None' NOT NULL,
	`match_operator` text DEFAULT 'And' NOT NULL,
	`literal_clauses` text DEFAULT '[]' NOT NULL,
	`action_label_id` text DEFAULT 'None' NOT NULL,
	`action_mailbox_id` text DEFAULT 'None' NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`applied_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`error_message` text DEFAULT '' NOT NULL,
	`ttl` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organize_job_request_by_account_config_id` ON `organize_job_request` (`account_config_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `quarantine` (
	`quarantine_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`account_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`uid` integer NOT NULL,
	`mailbox_role` text,
	`mailbox_path` text NOT NULL,
	`quarantined_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`failure_stage` text NOT NULL,
	`failure_code` text NOT NULL,
	`failure_message` text NOT NULL,
	`failure_part_path` text,
	`worker_version` text NOT NULL,
	`content_type` text,
	`transfer_encoding` text,
	`charset` text,
	`size_bytes` integer,
	`structure` text DEFAULT '[]' NOT NULL,
	`message_id_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quarantine_by_account_config_id` ON `quarantine` (`account_config_id`,`quarantined_at`);--> statement-breakpoint
CREATE TABLE `raw_message_storage` (
	`raw_storage_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`storage_type` text NOT NULL,
	`storage_location` text NOT NULL,
	`storage_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`content_encoding` text NOT NULL,
	`stored_at` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `raw_message_storage_by_message_id` ON `raw_message_storage` (`message_id`,`raw_storage_id`);--> statement-breakpoint
CREATE TABLE `sender_signer_standing` (
	`account_config_id` text NOT NULL,
	`sender_key` text NOT NULL,
	`signer_domain` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_affirmed_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_config_id`, `sender_key`, `signer_domain`)
);
--> statement-breakpoint
CREATE TABLE `sync_warning` (
	`sync_warning_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`account_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`uid` integer NOT NULL,
	`stage` text NOT NULL,
	`attempts` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_warning_by_mailbox_id` ON `sync_warning` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `sync_warning_by_account_config_id` ON `sync_warning` (`account_config_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `message_id_header`;