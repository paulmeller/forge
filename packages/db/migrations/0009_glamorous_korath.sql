CREATE TABLE `github_installation_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`repo` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gh_repo_unique` ON `github_installation_repos` (`installation_id`,`repo`);--> statement-breakpoint
CREATE INDEX `gh_repo_lookup_idx` ON `github_installation_repos` (`repo`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`agent_id` text,
	`github_vault_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gh_install_user_idx` ON `github_installations` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `gh_install_unique` ON `github_installations` (`installation_id`);