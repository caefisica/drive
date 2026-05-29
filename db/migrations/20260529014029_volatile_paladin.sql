CREATE TABLE `drive_items` (
	`id` text PRIMARY KEY NOT NULL,
	`drive_idx` integer NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer,
	`modified_time` integer,
	`url_path` text
);
--> statement-breakpoint
CREATE INDEX `idx_di_parent` ON `drive_items` (`drive_idx`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_di_path` ON `drive_items` (`drive_idx`,`url_path`);--> statement-breakpoint
CREATE INDEX `idx_di_name` ON `drive_items` (`name`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`drive_idx` integer PRIMARY KEY NOT NULL,
	`page_token` text,
	`last_synced_at` integer,
	`status` text DEFAULT 'idle' NOT NULL
);
