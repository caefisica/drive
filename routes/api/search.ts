import { defineHandler } from "void";
import { db } from "void/db";
import { like, eq, and } from "drizzle-orm";
import { driveItems } from "../../db/schema";
import { getDrives } from "../../src/config";
import { getFileKind } from "../../src/integrations/google-drive";

export const GET = defineHandler(async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const driveIdxParam = c.req.query("d");

  if (!q) return c.json({ error: "q is required" }, 400);

  const drives = getDrives(c.env);
  const pattern = `%${q}%`;

  const driveFilter =
    driveIdxParam !== undefined ? eq(driveItems.driveIdx, parseInt(driveIdxParam, 10)) : undefined;

  const results = await db
    .select()
    .from(driveItems)
    .where(
      driveFilter
        ? and(like(driveItems.name, pattern), driveFilter)
        : like(driveItems.name, pattern),
    )
    .limit(50);

  const items = results.map((r) => ({
    ...r,
    kind: getFileKind(r.mimeType),
    driveName: drives[r.driveIdx]?.name ?? `drive ${r.driveIdx}`,
  }));

  c.header("Content-Type", "text/html; charset=utf-8");
  const rows = items
    .map((item) => {
      const href = item.urlPath ?? `/${item.driveIdx}/`;
      return `<li><a href="${href}">${item.name}</a> <small>${item.driveName}</small></li>`;
    })
    .join("\n");

  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>search: ${q}</title></head>
<body>
<h1>results for "${q}"</h1>
${results.length === 0 ? "<p>no results</p>" : `<ul>${rows}</ul>`}
<p><a href="/">← back</a></p>
</body>
</html>`);
});
