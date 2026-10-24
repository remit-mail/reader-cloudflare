CREATE TABLE `address` (
	`address_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`display_name` text,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`normalized_email` text NOT NULL,
	`normalized_compound` text NOT NULL,
	`flags` text NOT NULL,
	`inbound_count` integer DEFAULT 0 NOT NULL,
	`outbound_count` integer DEFAULT 0 NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_inbound_at` integer DEFAULT 0 NOT NULL,
	`last_outbound_at` integer,
	`last_reply_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `address_by_account_config_id` ON `address` (`account_config_id`,`normalized_compound`);--> statement-breakpoint
CREATE TABLE `envelope_address` (
	`envelope_address_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`address_id` text NOT NULL,
	`display_name` text,
	`normalized_email` text NOT NULL,
	`address_role` text NOT NULL,
	`address_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `envelope_address_by_message_id` ON `envelope_address` (`message_id`,`envelope_address_id`);--> statement-breakpoint
CREATE TABLE `envelope` (
	`envelope_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`date_value` integer NOT NULL,
	`date_raw` text NOT NULL,
	`subject` text,
	`message_id_value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `envelope_by_message_id` ON `envelope` (`message_id`,`envelope_id`);--> statement-breakpoint
CREATE TABLE `mailbox_special_use_entry` (
	`mailbox_special_use_id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`special_use` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_special_use_entry_by_mailbox_id` ON `mailbox_special_use_entry` (`mailbox_id`,`mailbox_special_use_id`);--> statement-breakpoint
CREATE TABLE `mailbox` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`namespace_type` text DEFAULT 'personal' NOT NULL,
	`namespace_prefix` text NOT NULL,
	`hierarchy_delimiter` text NOT NULL,
	`full_path` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`uid_next` integer NOT NULL,
	`highest_modseq` text NOT NULL,
	`message_count` integer NOT NULL,
	`unseen_count` integer NOT NULL,
	`deleted_count` integer NOT NULL,
	`total_size` integer NOT NULL,
	`last_sync_uid` integer NOT NULL,
	`high_water_mark_uid` integer NOT NULL,
	`last_message_sync_at` integer NOT NULL,
	`initial_sync_completed_at` integer,
	`parent_mailbox_id` text DEFAULT 'None' NOT NULL,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`pending_path` text,
	`sync_failure_reason` text DEFAULT '' NOT NULL,
	`cursor_state` text DEFAULT 'normal' NOT NULL,
	`special_use` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_by_account_id` ON `mailbox` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_by_account_full_path` ON `mailbox` (`account_id`,`full_path`);--> statement-breakpoint
CREATE TABLE `message_flag` (
	`message_flag_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`flag_name` text NOT NULL,
	`set_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_flag_by_message_id` ON `message_flag` (`message_id`,`message_flag_id`);--> statement-breakpoint
CREATE TABLE `message` (
	`message_id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`uid` integer NOT NULL,
	`sequence_number` integer NOT NULL,
	`rfc822_size` integer NOT NULL,
	`internal_date` integer NOT NULL,
	`message_id_header` text,
	`envelope_id` text NOT NULL,
	`root_body_part_id` text NOT NULL,
	`body_storage_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`abandoned_mutation` text DEFAULT 'none' NOT NULL,
	`original_mailbox_id` text,
	`original_uid` integer,
	`category` text DEFAULT 'uncategorized' NOT NULL,
	`classification_state` text DEFAULT 'NotExamined' NOT NULL,
	`authenticity` text,
	`authenticity_verdict` text DEFAULT 'NotEvaluated' NOT NULL,
	`auth_result` text,
	`provider_spam` text,
	`has_list_unsubscribe` integer DEFAULT false NOT NULL,
	`moved_by_remit` integer DEFAULT false NOT NULL,
	`placement_verdict` text,
	`filter_move` text,
	`placement_decided_at` integer,
	`spam_report` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_by_mailbox_id` ON `message` (`mailbox_id`,`uid`);--> statement-breakpoint
CREATE TABLE `thread_message` (
	`thread_message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`uid` integer NOT NULL,
	`message_id_header` text,
	`in_reply_to` text,
	`reference_order` integer NOT NULL,
	`from_email` text,
	`from_name` text,
	`subject` text,
	`list_id` text,
	`internal_date` integer NOT NULL,
	`sent_date` integer NOT NULL,
	`is_read` integer NOT NULL,
	`has_attachment` integer NOT NULL,
	`star` text DEFAULT 'none' NOT NULL,
	`has_stars` integer NOT NULL,
	`is_deleted` integer NOT NULL,
	`snippet` text,
	`category` text DEFAULT 'uncategorized' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thread_message_by_mailbox_and_read_status` ON `thread_message` (`account_config_id`,`mailbox_id`,`is_read`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_by_starred` ON `thread_message` (`account_config_id`,`has_stars`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_by_attachment` ON `thread_message` (`account_config_id`,`has_attachment`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_by_mailbox_id` ON `thread_message` (`account_config_id`,`mailbox_id`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_by_date` ON `thread_message` (`account_config_id`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_by_unread` ON `thread_message` (`account_config_id`,`is_read`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_by_message_id` ON `thread_message` (`message_id`);--> statement-breakpoint
CREATE INDEX `thread_message_by_thread_id` ON `thread_message` (`thread_id`,`sent_date`);--> statement-breakpoint
CREATE INDEX `thread_message_primary` ON `thread_message` (`account_config_id`,`thread_message_id`);--> statement-breakpoint
CREATE INDEX `tm_by_mailbox_category_date` ON `thread_message` (`account_config_id`,`mailbox_id`,`category`,`is_deleted`,`sent_date`);