ALTER TABLE `github_installation_repos` ADD `onboarding_state` text DEFAULT 'pending_onboarding' NOT NULL;--> statement-breakpoint
ALTER TABLE `github_installation_repos` ADD `onboarding_pr_url` text;--> statement-breakpoint
-- Repos connected before the onboarding gate shipped keep working: an upgrade
-- must not stop an existing fleet dispatching, and those operators consented
-- by using the product. New rows take the column default instead.
UPDATE `github_installation_repos` SET `onboarding_state` = 'active';