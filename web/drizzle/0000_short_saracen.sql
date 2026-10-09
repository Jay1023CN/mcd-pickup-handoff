CREATE TABLE `mobile_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`token_hash` text NOT NULL,
	`pair_hash` text,
	`pair_expires` integer NOT NULL,
	`heartbeat` integer DEFAULT 0 NOT NULL,
	`running_job` text,
	`lock_until` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mobile_devices_owner_idx` ON `mobile_devices` (`owner_id`);--> statement-breakpoint
CREATE INDEX `mobile_devices_pair_idx` ON `mobile_devices` (`pair_hash`);--> statement-breakpoint
CREATE TABLE `mobile_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`device_id` text NOT NULL,
	`share_id` text,
	`action` text NOT NULL,
	`args` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mobile_jobs_queue_idx` ON `mobile_jobs` (`device_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `mobile_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mobile_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`record_id` text NOT NULL,
	`card` text NOT NULL,
	`queried_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`verified` integer NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	`refreshed_at` integer DEFAULT 0 NOT NULL
);
