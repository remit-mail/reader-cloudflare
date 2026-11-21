CREATE TABLE `tenant_email` (
	`tenant_id` text PRIMARY KEY,
	`email` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_email_email` ON `tenant_email` (`email`);--> statement-breakpoint
INSERT OR IGNORE INTO `tenant_email` (`tenant_id`, `email`) SELECT `id`, lower(`email`) FROM `mcp_user` WHERE `email` NOT LIKE '%@subject.invalid';
