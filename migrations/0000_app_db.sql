CREATE TABLE `account_config` (
	`account_config_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`state` text DEFAULT 'active' NOT NULL,
	`deleted_at` integer,
	`cascade_started_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_config_by_user_id` ON `account_config` (`user_id`,`account_config_id`);--> statement-breakpoint
CREATE TABLE `account_setting` (
	`account_setting_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_setting_by_account_config_id` ON `account_setting` (`account_config_id`,`name`);--> statement-breakpoint
CREATE TABLE `account` (
	`account_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`auth_type` text DEFAULT 'password' NOT NULL,
	`synced_services` text NOT NULL,
	`granted_scopes` text DEFAULT '[]' NOT NULL,
	`password_hash` text,
	`oauth_refresh_token_hash` text,
	`oauth_token_updated_at` integer,
	`imap_host` text NOT NULL,
	`imap_port` integer NOT NULL,
	`imap_tls` integer NOT NULL,
	`imap_start_tls` integer NOT NULL,
	`smtp_enabled` integer DEFAULT false NOT NULL,
	`smtp_host` text DEFAULT '' NOT NULL,
	`smtp_port` integer DEFAULT 587 NOT NULL,
	`smtp_tls` integer DEFAULT false NOT NULL,
	`smtp_start_tls` integer DEFAULT true NOT NULL,
	`smtp_username` text DEFAULT '' NOT NULL,
	`smtp_password_hash` text,
	`is_active` integer NOT NULL,
	`connection_state` text NOT NULL,
	`last_connected_at` integer,
	`last_sync_at` integer,
	`last_error` text,
	`sync_phase` text,
	`mailbox_count_total` integer,
	`mailbox_count_synced` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_by_account_config_id` ON `account` (`account_config_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `credential` (
	`account_id` text PRIMARY KEY NOT NULL,
	`key_version` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credential_by_key_version` ON `credential` (`key_version`);--> statement-breakpoint
CREATE TABLE `filter` (
	`filter_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` text,
	`ttl` integer,
	`state` text DEFAULT 'Active' NOT NULL,
	`disabled_reason` text DEFAULT 'None' NOT NULL,
	`has_anchor` integer DEFAULT false NOT NULL,
	`rule_changed_at` integer NOT NULL,
	`action_changed_at` integer NOT NULL,
	`match_operator` text DEFAULT 'And' NOT NULL,
	`literal_clauses` text DEFAULT '[]' NOT NULL,
	`action_label_id` text DEFAULT 'None' NOT NULL,
	`action_mailbox_id` text DEFAULT 'None' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `filter_by_account_and_state` ON `filter` (`account_config_id`,`state`,`filter_id`);--> statement-breakpoint
CREATE INDEX `filter_primary` ON `filter` (`account_config_id`,`filter_id`);--> statement-breakpoint
CREATE TABLE `label` (
	`label_id` text PRIMARY KEY NOT NULL,
	`account_config_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`color` text DEFAULT 'Default' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `label_by_normalized_name` ON `label` (`account_config_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `label_primary` ON `label` (`account_config_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `tenant_account` (
	`tenant_id` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `account_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_account_account_id_unique` ON `tenant_account` (`account_id`);