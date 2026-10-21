CREATE TABLE `crawl_pending` (
	`drive_idx` integer NOT NULL,
	`folder_id` text NOT NULL,
	PRIMARY KEY(`drive_idx`, `folder_id`)
);
--> statement-breakpoint
ALTER TABLE `drive_items` ADD `shortcut_target_id` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `crawled_at` integer;--> statement-breakpoint
DELETE FROM `drive_removals`;--> statement-breakpoint
DELETE FROM `drive_items`;--> statement-breakpoint
DELETE FROM `sync_state`;