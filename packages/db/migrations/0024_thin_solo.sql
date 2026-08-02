PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ledger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`task_id` text,
	`event_type` text NOT NULL,
	`payload` text,
	`source_event_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_ledger_events`("id", "mission_id", "task_id", "event_type", "payload", "source_event_id", "created_at") SELECT "id", "mission_id", "task_id", "event_type", "payload", "source_event_id", "created_at" FROM `ledger_events`;--> statement-breakpoint
DROP TABLE `ledger_events`;--> statement-breakpoint
ALTER TABLE `__new_ledger_events` RENAME TO `ledger_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ledger_mission_created_idx` ON `ledger_events` (`mission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_task_created_idx` ON `ledger_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_event_type_idx` ON `ledger_events` (`event_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_task_source_event_unique_idx` ON `ledger_events` (`task_id`,`source_event_id`);