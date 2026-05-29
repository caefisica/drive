import type { CloudEnv } from "void";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { fetchChanges, getStartPageToken, listDirectory } from "../integrations/google-drive";
import { driveItems, syncState } from "../../db/schema";

function makeDb(env: CloudEnv["Bindings"]) {
  return drizzle(env.DB);
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

      for (const change of result.changes) {
        if (change.removed || change.file?.trashed) {
          await db
            .delete(driveItems)
            .where(and(eq(driveItems.driveIdx, driveIdx), eq(driveItems.id, change.fileId)));
          await invalidateKvForFile(change.fileId, driveIdx, env);
          continue;
        }

        if (!change.file) continue;
        const f = change.file;

        await db
          .insert(driveItems)
          .values({
            id: f.id,
            driveIdx,
            parentId: f.parents?.[0] ?? null,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : null,
            urlPath: null,
          })
          .onConflictDoUpdate({
            target: driveItems.id,
            set: {
              parentId: f.parents?.[0] ?? null,
              name: f.name,
              mimeType: f.mimeType,
              size: f.size,
              modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : null,
              urlPath: null,
            },
          });

        await invalidateKvForFile(f.id, driveIdx, env);
      }

      if (result.newStartPageToken) {
        pageToken = result.newStartPageToken;
        break;
      }
      if (!result.nextPageToken) break;
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
  } catch (err) {
    await db.update(syncState).set({ status: "error" }).where(eq(syncState.driveIdx, driveIdx));
    throw err;
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
): Promise<{ fileCount: number; folderIds: Array<{ id: string; path: string }> }> {
  const db = makeDb(env);
  let pageToken: string | undefined;
  let fileCount = 0;
  const folderIds: Array<{ id: string; path: string }> = [];

  do {
    const result = await listDirectory(driveIdx, folderId, env, pageToken);

    const rows = result.files.map((f) => ({
      id: f.id,
      driveIdx,
      parentId: folderId,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : null,
      urlPath: `${urlPath}${f.name}${f.mimeType === "application/vnd.google-apps.folder" ? "/" : ""}`,
    }));

    if (rows.length > 0) {
      await db
        .insert(driveItems)
        .values(rows)
        .onConflictDoUpdate({
          target: driveItems.id,
          set: {
            name: driveItems.name,
            mimeType: driveItems.mimeType,
            size: driveItems.size,
            modifiedTime: driveItems.modifiedTime,
            urlPath: driveItems.urlPath,
          },
        });
    }

    for (const f of result.files) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        folderIds.push({ id: f.id, path: `${urlPath}${f.name}/` });
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
  await db
    .insert(syncState)
    .values({ driveIdx, pageToken, lastSyncedAt: Date.now(), status: "crawling" })
    .onConflictDoUpdate({
      target: syncState.driveIdx,
      set: { pageToken, lastSyncedAt: Date.now(), status: "crawling" },
    });
}

export async function markCrawlComplete(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<void> {
  const db = makeDb(env);
  await db
    .update(syncState)
    .set({ status: "idle", lastSyncedAt: Date.now() })
    .where(eq(syncState.driveIdx, driveIdx));
}

export async function backfillD1Item(
  driveIdx: number,
  parentId: string,
  file: { id: string; name: string; mimeType: string; size?: number; modifiedTime?: string },
  urlPath: string,
  env: CloudEnv["Bindings"],
): Promise<void> {
  const db = makeDb(env);
  await db
    .insert(driveItems)
    .values({
      id: file.id,
      driveIdx,
      parentId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      modifiedTime: file.modifiedTime ? new Date(file.modifiedTime).getTime() : null,
      urlPath,
    })
    .onConflictDoNothing();
}
