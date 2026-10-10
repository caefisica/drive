import type { CloudEnv } from "void";
import { and, eq, getTableColumns, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { queues } from "void/queues";

import { driveItems, driveRemovals, syncState } from "../../db/schema";
import { getDrive } from "../config";
import {
  fetchChanges,
  getStartPageToken,
  listDirectory,
  FOLDER_MIME,
  PASSWORD_FILE,
  resolveFolderId,
  type DriveFile,
} from "../integrations/google-drive";

// D1 rejects statements with more than 100 bound parameters.
// A multi-row insert binds one parameter per column in each row.
const ROWS_PER_INSERT = Math.floor(100 / Object.keys(getTableColumns(driveItems)).length);

function makeDb(env: CloudEnv["Bindings"]) {
  return drizzle(env.DB);
}

function chunkRows<T>(rows: T[]): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    chunks.push(rows.slice(start, start + ROWS_PER_INSERT));
  }

  return chunks;
}

const ROWS_PER_BATCH = 100;

// `last` runs after the inserts of every batch, in the same transaction.
async function insertRows(
  db: ReturnType<typeof makeDb>,
  rows: Array<typeof driveItems.$inferInsert>,
  insert: (chunk: Array<typeof driveItems.$inferInsert>) => BatchItem<"sqlite">,
  last?: BatchItem<"sqlite">,
): Promise<void> {
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    const statements = chunkRows(rows.slice(start, start + ROWS_PER_BATCH)).map(insert);
    if (last) statements.push(last);

    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

// Returns the value proposed by the conflicting insert, not the column's current value.
function incoming(column: SQLiteColumn) {
  return sql.raw(`excluded."${column.name}"`);
}

// Drive keeps no version that a move bumps, so the order of writes is local. Every batch of the
// change feed takes the next number of its drive's counter and stamps the rows it writes with it.
// A crawl reads the counter before it lists, so it may replace a row only if the feed stamped the
// row no later than that read. A listing read before a change therefore cannot undo it, however
// late it is written, and the feed always replaces. A move needs no modified time to win.
function feedSeqOf(driveIdx: number) {
  return sql<number>`(select ${syncState.feedSeq} from ${syncState} where ${syncState.driveIdx} = ${driveIdx})`;
}

async function readFeedSeq(db: ReturnType<typeof makeDb>, driveIdx: number): Promise<number> {
  const [state] = await db
    .select({ feedSeq: syncState.feedSeq })
    .from(syncState)
    .where(eq(syncState.driveIdx, driveIdx));

  return state?.feedSeq ?? 0;
}

// A row holds what Drive says about one file: its own name, not the name its URL uses.
function itemRow(
  driveIdx: number,
  parentId: string | null,
  file: Pick<DriveFile, "id" | "name" | "mimeType" | "size" | "modifiedTime">,
) {
  return {
    id: file.id,
    driveIdx,
    parentId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    modifiedTime: file.modifiedTime ? new Date(file.modifiedTime).getTime() : null,
  };
}

// A removal outlives any crawl that could still write the file back: a crawl reads its listing
// and writes it within one queue message.
const REMOVAL_TTL_MS = 60 * 60 * 1000;

// D1 binds at most 100 parameters, and a delete by ID also binds the drive, the parent and the
// counter.
const IDS_PER_DELETE = 90;

// An init that has not stored a page token this long after it was queued is presumed lost.
const INIT_STALE_MS = 60 * 60 * 1000;

// Claim the init only when no fresh claim exists, so concurrent callers queue it once.
async function claimInit(driveIdx: number, env: CloudEnv["Bindings"]): Promise<boolean> {
  const now = Date.now();
  const claimed = await makeDb(env)
    .insert(syncState)
    .values({ driveIdx, status: "crawling", crawlRequestedAt: now })
    .onConflictDoUpdate({
      target: syncState.driveIdx,
      set: { status: "crawling", crawlRequestedAt: now },
      setWhere: and(
        isNull(syncState.pageToken),
        or(
          ne(syncState.status, "crawling"),
          isNull(syncState.crawlRequestedAt),
          lte(syncState.crawlRequestedAt, now - INIT_STALE_MS),
        ),
      ),
    })
    .returning({ driveIdx: syncState.driveIdx });

  return claimed.length > 0;
}

export async function syncDrive(driveIdx: number, env: CloudEnv["Bindings"]): Promise<void> {
  if (!getDrive(driveIdx, env)) {
    return;
  }

  if (await runIncrementalSync(driveIdx, env)) {
    return;
  }

  if (!(await claimInit(driveIdx, env))) {
    return;
  }

  try {
    await queues.crawl.send({ type: "init", driveIdx });
  } catch (error) {
    // Without this the failed send would hold the claim for the full stale window.
    await makeDb(env)
      .update(syncState)
      .set({ status: "idle", crawlRequestedAt: null })
      .where(and(eq(syncState.driveIdx, driveIdx), isNull(syncState.pageToken)));

    throw error;
  }
}

export async function runIncrementalSync(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<boolean> {
  const db = makeDb(env);

  const [state] = await db.select().from(syncState).where(eq(syncState.driveIdx, driveIdx));

  if (!state?.pageToken) {
    return false;
  }

  await db.update(syncState).set({ status: "syncing" }).where(eq(syncState.driveIdx, driveIdx));

  let pageToken = state.pageToken;

  try {
    while (true) {
      const result = await fetchChanges(driveIdx, pageToken, env);
      const statements: BatchItem<"sqlite">[] = [];
      const touchedIds: string[] = [];
      const now = Date.now();

      for (const change of result.changes) {
        if (change.removed || change.file?.trashed) {
          const removal = { id: change.fileId, driveIdx, feedSeq: feedSeqOf(driveIdx) };

          statements.push(
            db
              .delete(driveItems)
              .where(and(eq(driveItems.driveIdx, driveIdx), eq(driveItems.id, change.fileId))),
            db
              .insert(driveRemovals)
              .values({ ...removal, removedAt: now })
              .onConflictDoUpdate({
                target: driveRemovals.id,
                set: { feedSeq: removal.feedSeq, removedAt: now },
              }),
          );

          touchedIds.push(change.fileId);
          continue;
        }

        if (!change.file) {
          continue;
        }

        // A file renamed to the password name leaves the index, as listings hide it.
        if (change.file.name === PASSWORD_FILE) {
          statements.push(
            db
              .delete(driveItems)
              .where(and(eq(driveItems.driveIdx, driveIdx), eq(driveItems.id, change.file.id))),
          );

          touchedIds.push(change.file.id);
          continue;
        }

        statements.push(db.delete(driveRemovals).where(eq(driveRemovals.id, change.file.id)));

        const row = {
          ...itemRow(driveIdx, change.file.parents?.[0] ?? null, change.file),
          feedSeq: feedSeqOf(driveIdx),
        };

        statements.push(
          db
            .insert(driveItems)
            .values(row)
            .onConflictDoUpdate({
              target: driveItems.id,
              set: {
                parentId: row.parentId,
                name: row.name,
                mimeType: row.mimeType,
                size: row.size,
                modifiedTime: row.modifiedTime,
                feedSeq: row.feedSeq,
              },
            }),
        );

        touchedIds.push(change.file.id);
      }

      if (statements.length > 0) {
        statements.unshift(
          db
            .update(syncState)
            .set({ feedSeq: sql`${syncState.feedSeq} + 1` })
            .where(eq(syncState.driveIdx, driveIdx)),
        );
        statements.push(
          db
            .delete(driveRemovals)
            .where(
              and(
                eq(driveRemovals.driveIdx, driveIdx),
                lt(driveRemovals.removedAt, now - REMOVAL_TTL_MS),
              ),
            ),
        );

        await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

        await Promise.all(touchedIds.map((id) => invalidateKvForFile(id, driveIdx, env)));
      }

      if (result.newStartPageToken) {
        pageToken = result.newStartPageToken;
        break;
      }

      if (!result.nextPageToken) {
        break;
      }

      pageToken = result.nextPageToken;
    }

    await db
      .update(syncState)
      .set({
        pageToken,
        lastSyncedAt: Date.now(),
        status: "idle",
      })
      .where(eq(syncState.driveIdx, driveIdx));

    return true;
  } catch (error) {
    await db.update(syncState).set({ status: "error" }).where(eq(syncState.driveIdx, driveIdx));

    throw error;
  }
}

async function invalidateKvForFile(
  fileId: string,
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<void> {
  // Parent directories are not known here. Invalidate file metadata cache only.
  await env.KV.delete(`meta:${driveIdx}:${fileId}`);
}

// Deletes the rows of a folder that its listing lacks. A row the feed stamped after the counter was
// read stays: the listing may be older than that change, and the feed is ahead of it.
async function deleteAbsent(
  db: ReturnType<typeof makeDb>,
  driveIdx: number,
  folderId: string,
  listed: DriveFile[],
  feedSeq: number,
): Promise<void> {
  const present = new Set(listed.map((file) => file.id));
  const rows = await db
    .select({ id: driveItems.id })
    .from(driveItems)
    .where(and(eq(driveItems.driveIdx, driveIdx), eq(driveItems.parentId, folderId)));
  const absent = rows.map((row) => row.id).filter((id) => !present.has(id));

  for (let start = 0; start < absent.length; start += IDS_PER_DELETE) {
    await db
      .delete(driveItems)
      .where(
        and(
          eq(driveItems.driveIdx, driveIdx),
          eq(driveItems.parentId, folderId),
          inArray(driveItems.id, absent.slice(start, start + IDS_PER_DELETE)),
          or(isNull(driveItems.feedSeq), lte(driveItems.feedSeq, feedSeq)),
        ),
      );
  }
}

export async function crawlFolder(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
): Promise<{
  fileCount: number;
  folderIds: string[];
}> {
  const db = makeDb(env);
  const feedSeq = await readFeedSeq(db, driveIdx);
  // Read the counter before listing. A cached listing could predate that read.
  const files = await listDirectory(driveIdx, folderId, env, { fresh: true });

  await insertRows(
    db,
    files.map((file) => itemRow(driveIdx, folderId, file)),
    (chunk) =>
      db
        .insert(driveItems)
        .values(chunk)
        .onConflictDoUpdate({
          target: driveItems.id,
          set: {
            parentId: incoming(driveItems.parentId),
            name: incoming(driveItems.name),
            mimeType: incoming(driveItems.mimeType),
            size: incoming(driveItems.size),
            modifiedTime: incoming(driveItems.modifiedTime),
          },
          setWhere: sql`${driveItems.feedSeq} is null or ${driveItems.feedSeq} <= ${feedSeq}`,
        }),
    // A file the feed removed after the counter was read may still be in the listing.
    db.delete(driveItems).where(
      and(
        eq(driveItems.driveIdx, driveIdx),
        inArray(
          driveItems.id,
          db
            .select({ id: driveRemovals.id })
            .from(driveRemovals)
            .where(and(eq(driveRemovals.driveIdx, driveIdx), gt(driveRemovals.feedSeq, feedSeq))),
        ),
      ),
    ),
  );

  await deleteAbsent(db, driveIdx, folderId, files, feedSeq);

  const folders = files.filter((file) => file.mimeType === FOLDER_MIME);

  return {
    fileCount: files.length - folders.length,
    folderIds: folders.map((folder) => folder.id),
  };
}

export async function initializeSyncState(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<void> {
  const db = makeDb(env);
  const pageToken = await getStartPageToken(driveIdx, env);
  const now = Date.now();

  await db
    .insert(syncState)
    .values({
      driveIdx,
      pageToken,
      lastSyncedAt: now,
      crawlRequestedAt: null,
      status: "crawling",
    })
    .onConflictDoUpdate({
      target: syncState.driveIdx,
      set: {
        pageToken,
        lastSyncedAt: now,
        crawlRequestedAt: null,
        status: "crawling",
      },
    });
}

export async function backfillD1Items(
  driveIdx: number,
  parentId: string,
  files: DriveFile[],
  env: CloudEnv["Bindings"],
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const db = makeDb(env);
  const realParentId = await resolveFolderId(driveIdx, parentId, env);

  await insertRows(
    db,
    files.map((file) => itemRow(driveIdx, realParentId, file)),
    (chunk) => db.insert(driveItems).values(chunk).onConflictDoNothing(),
  );
}
