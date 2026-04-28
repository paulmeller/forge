ALTER TABLE `ledger_events` ADD `source_event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_task_source_event_unique_idx` ON `ledger_events` (`task_id`,`source_event_id`);