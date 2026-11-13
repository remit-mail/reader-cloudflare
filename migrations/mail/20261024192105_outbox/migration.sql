CREATE TABLE `outbox_attachment` (
	`outbox_attachment_id` text PRIMARY KEY NOT NULL,
	`outbox_message_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`storage_key` text NOT NULL,
	`reservation_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_attachment_by_outbox_message_id` ON `outbox_attachment` (`outbox_message_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `outbox_message` (
	`outbox_message_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`account_config_id` text NOT NULL,
	`from_address` text NOT NULL,
	`from_name` text,
	`to_addresses` text NOT NULL,
	`cc_addresses` text DEFAULT '[]' NOT NULL,
	`bcc_addresses` text DEFAULT '[]' NOT NULL,
	`reply_to_address` text,
	`subject` text,
	`message_id_value` text NOT NULL,
	`in_reply_to` text,
	`references` text DEFAULT '[]' NOT NULL,
	`text_body` text,
	`html_body` text,
	`status` text NOT NULL,
	`last_error` text,
	`last_smtp_code` integer,
	`sent_at` integer,
	`smtp_message_id` text,
	`appended_uid` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_message_by_account_id` ON `outbox_message` (`account_id`,`created_at`);