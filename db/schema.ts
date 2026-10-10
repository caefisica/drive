import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    feedSeq: integer("feed_seq"),
  },
  (t) => [index("idx_di_siblings").on(t.driveIdx, t.parentId, t.name)],
);

// A file the change feed removed, kept briefly so that a crawl listing read before the removal
// cannot write the file back. `feedSeq` is the number of the batch that removed it.
export const driveRemovals = sqliteTable(
  "drive_removals",
  {
    id: text("id").primaryKey(),
    driveIdx: integer("drive_idx").notNull(),
    feedSeq: integer("feed_seq").notNull(),
    removedAt: integer("removed_at").notNull(),
  },
  (t) => [index("idx_dr_drive_seq").on(t.driveIdx, t.feedSeq)],
);

export const syncState = sqliteTable("sync_state", {
  driveIdx: integer("drive_idx").primaryKey(),
  pageToken: text("page_token"),
  lastSyncedAt: integer("last_synced_at"),
  crawlRequestedAt: integer("crawl_requested_at"),
  feedSeq: integer("feed_seq").notNull().default(0),
  status: text("status")
    .$type<"idle" | "crawling" | "syncing" | "error">()
    .notNull()
    .default("idle"),
});
