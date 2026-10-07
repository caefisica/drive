ALTER TABLE `drive_items` ADD `feed_seq` integer;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `feed_seq` integer DEFAULT 0 NOT NULL;