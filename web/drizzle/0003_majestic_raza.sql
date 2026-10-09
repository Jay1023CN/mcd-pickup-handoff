CREATE INDEX `mobile_jobs_retention_idx` ON `mobile_jobs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mobile_shares_retention_idx` ON `mobile_shares` (`expires_at`);