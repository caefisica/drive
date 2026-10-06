import type { CloudEnv } from "void";
import { and, eq, getTableColumns, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { queues } from "void/queues";

import { driveItems, syncState } from "../../db/schema";
import { getDrive } from "../config";
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

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Folder paths end in a slash, so a child path is its parent's path plus its name.
export function directoryUrlPath(driveIdx: number, segments: string[]): string {
  return `/${[driveIdx, ...segments].join("/")}/`;
}

function itemUrlPath(parentPath: string, file: { name: string; mimeType: string }): string {
  return `${parentPath}${file.name}${file.mimeType === FOLDER_MIME ? "/" : ""}`;
}

type ChangedFile = { id: string; name: string; mimeType: string; parents?: string[] };

// Maps each changed file to its url path. Parents come from the index or from the same
// page, and a file whose parent is neither stays out of the map.
async function resolveUrlPaths(
  db: ReturnType<typeof makeDb>,
  driveIdx: number,
  rootId: string | undefined,
  files: ChangedFile[],
): Promise<Map<string, string>> {
  const inPage = new Set(files.map((file) => file.id));
  const parentPaths = new Map<string, string>();

  if (rootId) {
    parentPaths.set(rootId, directoryUrlPath(driveIdx, []));
  }

  const parentIds = new Set(files.flatMap((file) => file.parents?.slice(0, 1) ?? []));
  const indexedIds = [...parentIds].filter((id) => !inPage.has(id) && !parentPaths.has(id));

  for (const chunk of chunkRows(indexedIds)) {
    const rows = await db
      .select({ id: driveItems.id, urlPath: driveItems.urlPath })
      .from(driveItems)
      .where(and(eq(driveItems.driveIdx, driveIdx), inArray(driveItems.id, chunk)));

    for (const { id, urlPath } of rows) {
      if (urlPath) parentPaths.set(id, urlPath);
    }
  }

  const paths = new Map<string, string>();
  // Drive allows two files of one name in a folder, but a path names only one.
  const claimed = new Set<string>();
  let pending = files;

  while (pending.length > 0) {
    const unresolved: ChangedFile[] = [];

    for (const file of pending) {
      const parentPath = parentPaths.get(file.parents?.[0] ?? "");

      if (!parentPath) {
        unresolved.push(file);
        continue;
      }

      const path = itemUrlPath(parentPath, file);

      if (file.mimeType === FOLDER_MIME) {
        parentPaths.set(file.id, path);
      }

      if (!claimed.has(path)) {
        claimed.add(path);
        paths.set(file.id, path);
      }
    }

    if (unresolved.length === pending.length) break;
    pending = unresolved;
  }

  return paths;
}

// Clears these paths from any other row, so a file recreated under the same name can
// take the path of the one it replaces without tripping the unique path index.
function releaseUrlPaths(
  db: ReturnType<typeof makeDb>,
  driveIdx: number,
  paths: Map<string, string>,
): BatchItem<"sqlite"> {
  const claims = JSON.stringify([...paths].map(([id, path]) => ({ id, path })));

  return db
    .update(driveItems)
    .set({ urlPath: null })
    .where(
      and(
        eq(driveItems.driveIdx, driveIdx),
        sql`exists (
          select 1 from json_each(${claims}) j
          where json_extract(j.value, '$.path') = ${driveItems.urlPath}
            and json_extract(j.value, '$.id') != ${driveItems.id}
        )`,
      ),
    );
}

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

  const rootId = getDrive(driveIdx, env)?.rootId;
  let pageToken = state.pageToken;

  try {
    while (true) {
      const result = await fetchChanges(driveIdx, pageToken, env);
      const statements: BatchItem<"sqlite">[] = [];
      const touchedIds: string[] = [];

      const upserts = result.changes.flatMap((change) =>
        !change.removed && !change.file?.trashed && change.file ? [change.file] : [],
      );
      const urlPaths = await resolveUrlPaths(db, driveIdx, rootId, upserts);

      if (urlPaths.size > 0) {
        statements.push(releaseUrlPaths(db, driveIdx, urlPaths));
      }

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
        const urlPath = urlPaths.get(file.id) ?? null;

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
              urlPath,
            })
            .onConflictDoUpdate({
              target: driveItems.id,
              set: {
                parentId: file.parents?.[0] ?? null,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
                modifiedTime,
                // A file whose parent folder is not indexed keeps the path it had.
                urlPath: sql`coalesce(${incoming(driveItems.urlPath)}, ${driveItems.urlPath})`,
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
      urlPath: itemUrlPath(urlPath, file),
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
      if (file.mimeType === FOLDER_MIME) {
        folderIds.push({ id: file.id, path: itemUrlPath(urlPath, file) });
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
  parentPath: string,
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    modifiedTime?: string;
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
    urlPath: itemUrlPath(parentPath, file),
  }));

  const statements = chunkRows(rows).map((chunk): BatchItem<"sqlite"> =>
    db.insert(driveItems).values(chunk).onConflictDoNothing(),
  );

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
