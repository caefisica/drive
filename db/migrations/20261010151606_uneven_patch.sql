CREATE TABLE `drive_removals` (
	`id` text PRIMARY KEY NOT NULL,
	`drive_idx` integer NOT NULL,
	`feed_seq` integer NOT NULL,
	`removed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dr_drive_seq` ON `drive_removals` (`drive_idx`,`feed_seq`);