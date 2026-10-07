import type { CloudEnv } from "void";
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { getDrive } from "../config";
import { FOLDER_MIME, resolveFolderId } from "../integrations/google-drive";
import { urlName, urlPath } from "../url-names";

// Drive nests folders far less deeply. The bound keeps a parent cycle in the index from looping.
const MAX_DEPTH = 100;

type ChainRow = {
  origin: string;
  id: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  driveIdx: number;
  shared: number;
};

// Whether another file in the same folder carries the same name, read from the index.
function sharesName(alias: string) {
  return sql.raw(`exists (
    select 1 from drive_items s
    where s.drive_idx = ${alias}.drive_idx
      and s.parent_id = ${alias}.parent_id
      and s.name = ${alias}.name
      and s.id <> ${alias}.id
  )`);
}

// Derive each indexed file's URL from its own name and parent and the files on the way to the
// drive root. A file whose chain does not reach the root, or whose root ID cannot be resolved,
// links to the drive itself.
export async function itemUrls(
  db: Pick<DrizzleD1Database, "all">,
  files: Array<{ id: string; driveIdx: number }>,
  env: CloudEnv["Bindings"],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();

  if (files.length === 0) {
    return urls;
  }

  const rows = await db.all<ChainRow>(sql`
    with recursive chain(origin, depth, id, parent_id, name, mime_type, drive_idx, shared) as (
      select i.id, 0, i.id, i.parent_id, i.name, i.mime_type, i.drive_idx, ${sharesName("i")}
      from json_each(${JSON.stringify(files)}) j
      join drive_items i
        on i.drive_idx = json_extract(j.value, '$.driveIdx') and i.id = json_extract(j.value, '$.id')
      union all
      select c.origin, c.depth + 1, p.id, p.parent_id, p.name, p.mime_type, p.drive_idx,
        ${sharesName("p")}
      from chain c
      join drive_items p on p.drive_idx = c.drive_idx and p.id = c.parent_id
      where c.depth < ${MAX_DEPTH}
    )
    select origin, id, parent_id as parentId, name, mime_type as mimeType,
      drive_idx as driveIdx, shared
    from chain
    order by origin, depth
  `);

  const chains = Map.groupBy(rows, (row) => row.origin);
  const rootIds = new Map<number, string | null>();

  for (const { driveIdx } of files) {
    if (rootIds.has(driveIdx)) continue;

    const drive = getDrive(driveIdx, env);

    // Search answers from D1, so a Google failure here must not fail it. Without the root ID the
    // links of that drive point at the drive.
    rootIds.set(
      driveIdx,
      drive ? await resolveFolderId(driveIdx, drive.rootId, env).catch(() => null) : null,
    );
  }

  for (const { id, driveIdx } of files) {
    const chain = chains.get(id);
    const root = rootIds.get(driveIdx);

    if (!chain || !root || chain.at(-1)?.parentId !== root) {
      urls.set(id, urlPath(driveIdx, [], true));
      continue;
    }

    const names = chain.map((row) => urlName(row.name, row.id, row.shared === 1)).reverse();

    urls.set(id, urlPath(driveIdx, names, chain[0].mimeType === FOLDER_MIME));
  }

  return urls;
}
