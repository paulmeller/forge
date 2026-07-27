ALTER TABLE `tasks` ADD `escalation_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_decision` text;
--> statement-breakpoint
UPDATE `tasks` SET `status` = 'needs_human' WHERE `status` = 'awaiting_review';