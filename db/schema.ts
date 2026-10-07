import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const driveItems = sqliteTable(
  "drive_items",
  {
    id: text("id").primaryKey(),
    driveIdx: integer("drive_idx").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size"),
    modifiedTime: integer("modified_time"),
    urlPath: text("url_path"),
  },
  (t) => [
    index("idx_di_parent").on(t.driveIdx, t.parentId),
    uniqueIndex("uq_di_path").on(t.driveIdx, t.urlPath),
  ],
);

export const syncState = sqliteTable("sync_state", {
  driveIdx: integer("drive_idx").primaryKey(),
  pageToken: text("page_token"),
  lastSyncedAt: integer("last_synced_at"),
  crawlRequestedAt: integer("crawl_requested_at"),
  status: text("status")
    .$type<"idle" | "crawling" | "syncing" | "error">()
    .notNull()
    .default("idle"),
});
