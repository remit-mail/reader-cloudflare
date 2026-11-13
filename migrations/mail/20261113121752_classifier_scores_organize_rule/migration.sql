ALTER TABLE `message` ADD `classifier_scores` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_job_request` ADD `rule` text DEFAULT '{"version":0}' NOT NULL;