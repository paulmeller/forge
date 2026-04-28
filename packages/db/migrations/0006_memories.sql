CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_key` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`source_type` text,
	`source_id` text,
	`learned_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_scope_idx` ON `memories` (`scope`,`scope_key`);--> statement-breakpoint
CREATE INDEX `memories_key_idx` ON `memories` (`key`);--> statement-breakpoint
CREATE INDEX `memories_expires_idx` ON `memories` (`expires_at`);