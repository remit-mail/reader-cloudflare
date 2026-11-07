CREATE TABLE `captured_mail` (
	`captured_mail_id` text PRIMARY KEY NOT NULL,
	`captured_at` integer NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `captured_mail_captured_at` ON `captured_mail` (`captured_at`);