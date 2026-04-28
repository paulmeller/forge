ALTER TABLE `missions` ADD `ai_review_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `depends_on_ids` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `ai_review_retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_depends_on_idx`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `depends_on`;--> statement-breakpoint
CREATE INDEX `tasks_depends_on_idx` ON `tasks` (`depends_on_ids`);
