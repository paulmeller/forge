ALTER TABLE `missions` ADD `github_delivery_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `missions_github_delivery_unique_idx` ON `missions` (`github_delivery_id`);
