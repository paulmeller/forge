CREATE TABLE `ledger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`task_id` text,
	`event_type` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ledger_mission_created_idx` ON `ledger_events` (`mission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_task_created_idx` ON `ledger_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_event_type_idx` ON `ledger_events` (`event_type`);--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`backend` text NOT NULL,
	`agent_id` text NOT NULL,
	`planner_strategy` text DEFAULT 'rule-based' NOT NULL,
	`concurrency_cap` integer DEFAULT 5 NOT NULL,
	`budget_usd` integer,
	`budget_tokens` integer,
	`budget_threshold_pct` integer DEFAULT 80 NOT NULL,
	`spent_usd` integer DEFAULT 0 NOT NULL,
	`spent_tokens` integer DEFAULT 0 NOT NULL,
	`auto_merge_policy` text,
	`webhook_secret` text NOT NULL,
	`github_installation_id` text,
	`github_vault_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`repo` text NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`prompt_vars` text,
	`issue_ref` text,
	`depends_on` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`session_id` text,
	`pr_url` text,
	`pr_number` integer,
	`diff_additions` integer,
	`diff_deletions` integer,
	`files_changed` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`cost_usd` integer DEFAULT 0 NOT NULL,
	`cost_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`dispatched_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_mission_status_idx` ON `tasks` (`mission_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_depends_on_idx` ON `tasks` (`depends_on`);--> statement-breakpoint
CREATE INDEX `tasks_session_idx` ON `tasks` (`session_id`);