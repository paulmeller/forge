CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`description` text,
	`prompt_template` text NOT NULL,
	`allowed_tools` text,
	`remote_skill_id` text,
	`built_in` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);--> statement-breakpoint
ALTER TABLE `missions` ADD `skill_id` text;