CREATE TABLE `mobile_owner_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mobile_owner_sessions_expiry_idx` ON `mobile_owner_sessions` (`expires_at`);