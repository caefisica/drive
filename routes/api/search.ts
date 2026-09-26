import { and, eq, like } from "drizzle-orm";
import { defineHandler } from "void";
import { db } from "void/db";

import { driveItems } from "../../db/schema";
import { getDrives } from "../../src/config";

export const GET = defineHandler(async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const driveIdxParam = c.req.query("d");

  if (!q) {
    return c.json({ error: "q is required" }, 400);
  }

  let driveIdx: number | undefined;

  if (driveIdxParam !== undefined) {
    if (!/^\d+$/.test(driveIdxParam)) {
      return c.json({ error: "d must be a non-negative integer" }, 400);
    }

    driveIdx = Number(driveIdxParam);
  }

  const drives = getDrives(c.env);
  const pattern = `%${q}%`;

  const results = await db
    .select()
    .from(driveItems)
    .where(
      driveIdx === undefined
        ? like(driveItems.name, pattern)
        : and(like(driveItems.name, pattern), eq(driveItems.driveIdx, driveIdx)),
    )
    .limit(50);

  const rows = results
    .map((item) => {
      const href = item.urlPath ?? `/${item.driveIdx}/`;
      const driveName = drives[item.driveIdx]?.name ?? `drive ${item.driveIdx}`;

      return `<li><a href="${escapeHtml(href)}">${escapeHtml(item.name)}</a> <small>${escapeHtml(driveName)}</small></li>`;
    })
    .join("\n");

  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>search: ${escapeHtml(q)}</title></head>
<body>
<h1>results for "${escapeHtml(q)}"</h1>
${results.length === 0 ? "<p>no results</p>" : `<ul>${rows}</ul>`}
<p><a href="/">← back</a></p>
</body>
</html>`);
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
