import type { CloudEnv } from "void";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { driveItems, syncState } from "../../db/schema";
import { getDrive } from "../config";
import { FOLDER_MIME, getRootId, PASSWORD_FILE } from "../integrations/google-drive";
import { parseUrlName, withUrlNames } from "../url-names";

export type ListedFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  urlName: string;
};

type Item = Omit<ListedFile, "urlName">;

const itemColumns = {
  id: driveItems.id,
  name: driveItems.name,
  mimeType: driveItems.mimeType,
  size: driveItems.size,
  modifiedTime: driveItems.modifiedTime,
  shortcutTargetId: driveItems.shortcutTargetId,
};

function toItem(row: {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: number | null;
}): Item {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size ?? undefined,
    modifiedTime: row.modifiedTime === null ? undefined : new Date(row.modifiedTime).toISOString(),
  };
}

// The real ID of a drive's root once its crawl has read every folder. Null before that, and while the
// root ID the crawl stored is missing. Pages list a drive only through the index, so they ask here
// first and never read Google.
export async function crawledRoot(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<string | null> {
  const drive = getDrive(driveIdx, env);
  if (!drive) return null;

  const [state] = await drizzle(env.DB)
    .select({ crawledAt: syncState.crawledAt })
    .from(syncState)
    .where(eq(syncState.driveIdx, driveIdx));

  return state?.crawledAt ? getRootId(driveIdx, drive.rootId, env) : null;
}

// The answer for a drive that has no finished crawl. A page loader returns it as it is: Void sends a
// returned Response with a status of 300 or more unchanged, but ignores a status set on page props.
export function notCrawledResponse(): Response {
  return Response.json(
    { error: "not indexed yet: the drive is still being read, try again in a few minutes" },
    { status: 503, headers: { "retry-after": "300" } },
  );
}

// Home, folder pages and search name a file through the index, so a file has one URL name
// everywhere. The whole folder is read at once because a name is shared only in relation to every
// other file of the folder.
export async function listFolder(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
): Promise<ListedFile[]> {
  const rows = await drizzle(env.DB)
    .select(itemColumns)
    .from(driveItems)
    .where(
      and(
        eq(driveItems.driveIdx, driveIdx),
        eq(driveItems.parentId, folderId),
        ne(driveItems.name, PASSWORD_FILE),
      ),
    )
    .orderBy(
      desc(sql`${driveItems.mimeType} = ${FOLDER_MIME}`),
      sql`${driveItems.name} collate nocase`,
      driveItems.name,
      desc(driveItems.modifiedTime),
      driveItems.id,
    );

  return withUrlNames(rows.map(toItem));
}

// Finds the file a URL segment names, by the rule `urlName` applies to a listing. A plain segment
// names a file only when no sibling shares its name, and a suffixed one names the file whose ID
// it carries. A shortcut resolves to the file it points at, so the lookup goes on in the target.
async function resolveSegment(
  driveIdx: number,
  parentId: string,
  segment: string,
  env: CloudEnv["Bindings"],
): Promise<{ id: string; item: Item } | null> {
  const { name, id } = parseUrlName(segment);
  // Listings hide the password file, so no URL names it.
  if (name === PASSWORD_FILE) return null;

  const siblings = await drizzle(env.DB)
    .select(itemColumns)
    .from(driveItems)
    .where(
      and(
        eq(driveItems.driveIdx, driveIdx),
        eq(driveItems.parentId, parentId),
        eq(driveItems.name, name),
      ),
    );
  const row =
    id === null
      ? siblings.length === 1
        ? siblings[0]
        : undefined
      : siblings.find((sibling) => sibling.id === id);

  return row ? { id: row.shortcutTargetId ?? row.id, item: toItem(row) } : null;
}

// `rootId` is the real root ID from `crawledRoot`. `ids` starts with the root as configured, which
// is the ID a folder password is stored under, and `finalId` is the ID whose children the index
// holds. `item` describes the last segment and is null for the root.
export async function resolvePath(
  driveIdx: number,
  segments: string[],
  rootId: string,
  env: CloudEnv["Bindings"],
): Promise<{ ids: string[]; finalId: string; item: Item | null } | null> {
  const drive = getDrive(driveIdx, env);
  if (!drive) return null;

  const ids: string[] = [drive.rootId];
  let finalId = rootId;
  let item: Item | null = null;

  for (const segment of segments) {
    const next = await resolveSegment(driveIdx, finalId, segment, env);
    if (!next) return null;
    ids.push(next.id);
    finalId = next.id;
    item = next.item;
  }

  return { ids, finalId, item };
}
