CREATE TABLE `mission_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`goal_template` text NOT NULL,
	`default_backend` text NOT NULL,
	`default_concurrency_cap` integer DEFAULT 5 NOT NULL,
	`default_budget_usd` integer,
	`skill_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
