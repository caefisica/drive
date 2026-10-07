-- void:allow-destructive
DROP INDEX `idx_di_parent`;--> statement-breakpoint
DROP INDEX `uq_di_path`;--> statement-breakpoint
CREATE INDEX `idx_di_siblings` ON `drive_items` (`drive_idx`,`parent_id`,`name`);--> statement-breakpoint
ALTER TABLE `drive_items` DROP COLUMN `url_path`;