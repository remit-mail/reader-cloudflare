CREATE TABLE `dead_letter` (
	`dead_letter_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`type` text NOT NULL,
	`attempts` integer NOT NULL,
	`body` text NOT NULL
);
