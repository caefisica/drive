import type { CloudEnv } from "void";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { driveItems, syncState } from "../../db/schema";
import { fetchChanges, getStartPageToken, listDirectory } from "../integrations/google-drive";

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

// Returns the value proposed by the conflicting insert, not the column's current value.
function incoming(column: SQLiteColumn) {
  return sql.raw(`excluded."${column.name}"`);
}

export async function runIncrementalSync(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<void> {
  const db = makeDb(env);

  const [state] = await db.select().from(syncState).where(eq(syncState.driveIdx, driveIdx));

  if (!state?.pageToken) {
    console.log(`[sync] drive ${driveIdx}: no pageToken, skipping (run full crawl first)`);
    return;
  }

  await db.update(syncState).set({ status: "syncing" }).where(eq(syncState.driveIdx, driveIdx));

  let pageToken = state.pageToken;

  try {
    while (true) {
      const result = await fetchChanges(driveIdx, pageToken, env);
      const statements: BatchItem<"sqlite">[] = [];
      const touchedIds: string[] = [];

      for (const change of result.changes) {
        if (change.removed || change.file?.trashed) {
          statements.push(
            db
              .delete(driveItems)
              .where(and(eq(driveItems.driveIdx, driveIdx), eq(driveItems.id, change.fileId))),
          );

          touchedIds.push(change.fileId);
          continue;
        }

        if (!change.file) {
          continue;
        }

        const file = change.file;
        const modifiedTime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : null;

        statements.push(
          db
            .insert(driveItems)
            .values({
              id: file.id,
              driveIdx,
              parentId: file.parents?.[0] ?? null,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
              modifiedTime,
              urlPath: null,
            })
            .onConflictDoUpdate({
              target: driveItems.id,
              set: {
                parentId: file.parents?.[0] ?? null,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
                modifiedTime,
                urlPath: null,
              },
            }),
        );

        touchedIds.push(file.id);
      }

      if (statements.length > 0) {
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

export async function crawlFolder(
  driveIdx: number,
  folderId: string,
  urlPath: string,
  env: CloudEnv["Bindings"],
): Promise<{
  fileCount: number;
  folderIds: Array<{ id: string; path: string }>;
}> {
  const db = makeDb(env);
  let pageToken: string | undefined;
  let fileCount = 0;
  const folderIds: Array<{ id: string; path: string }> = [];

  do {
    const result = await listDirectory(driveIdx, folderId, env, pageToken);

    const rows = result.files.map((file) => ({
      id: file.id,
      driveIdx,
      parentId: folderId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      modifiedTime: file.modifiedTime ? new Date(file.modifiedTime).getTime() : null,
      urlPath: `${urlPath}${file.name}${
        file.mimeType === "application/vnd.google-apps.folder" ? "/" : ""
      }`,
    }));

    if (rows.length > 0) {
      const statements = chunkRows(rows).map((chunk): BatchItem<"sqlite"> =>
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
              urlPath: incoming(driveItems.urlPath),
            },
          }),
      );

      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    }

    for (const file of result.files) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        folderIds.push({
          id: file.id,
          path: `${urlPath}${file.name}/`,
        });
      } else {
        fileCount++;
      }
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  return { fileCount, folderIds };
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
      status: "crawling",
    })
    .onConflictDoUpdate({
      target: syncState.driveIdx,
      set: {
        pageToken,
        lastSyncedAt: now,
        status: "crawling",
      },
    });
}

export async function markCrawlComplete(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<void> {
  const db = makeDb(env);

  await db
    .update(syncState)
    .set({
      status: "idle",
      lastSyncedAt: Date.now(),
    })
    .where(eq(syncState.driveIdx, driveIdx));
}

export async function backfillD1Items(
  driveIdx: number,
  parentId: string,
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    modifiedTime?: string;
    urlPath: string;
  }>,
  env: CloudEnv["Bindings"],
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const db = makeDb(env);

  const rows = files.map((file) => ({
    id: file.id,
    driveIdx,
    parentId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    modifiedTime: file.modifiedTime ? new Date(file.modifiedTime).getTime() : null,
    urlPath: file.urlPath,
  }));

  const statements = chunkRows(rows).map((chunk): BatchItem<"sqlite"> =>
    db.insert(driveItems).values(chunk).onConflictDoNothing(),
  );

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
