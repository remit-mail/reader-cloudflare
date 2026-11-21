CREATE TABLE `classification_default` (
	`classification_default_id` text PRIMARY KEY,
	`preset_id` text NOT NULL,
	`model` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_sealed` blob NOT NULL,
	`iv` blob NOT NULL,
	`key_version` integer NOT NULL,
	`daily_limit` integer NOT NULL,
	`enabled` integer NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
