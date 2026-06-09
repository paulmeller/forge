ALTER TABLE `missions` ADD `budget_hard_stop_pct` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `missions` ADD `task_max_tokens` integer;--> statement-breakpoint
ALTER TABLE `missions` ADD `task_max_turns` integer;--> statement-breakpoint
ALTER TABLE `missions` ADD `no_progress_tokens` integer;--> statement-breakpoint
ALTER TABLE `missions` ADD `self_verify_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `loop_policy` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `turn_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_progress_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cost_tokens_at_progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `verify_retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_verified_sha` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `halt_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `acceptance_criteria` text;
