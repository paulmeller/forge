ALTER TABLE `missions` ADD `issue_query` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kind` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `verdict` text;
