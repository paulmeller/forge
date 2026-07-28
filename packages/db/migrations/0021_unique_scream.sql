CREATE UNIQUE INDEX `device_code_unique` ON `deviceCode` (`deviceCode`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_user_code_unique` ON `deviceCode` (`userCode`);--> statement-breakpoint
ALTER TABLE `deviceCode` ALTER COLUMN "userId" TO "userId" text REFERENCES user(id) ON DELETE cascade ON UPDATE no action;