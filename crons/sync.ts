import { defineScheduled } from "void";

import { getDrives } from "../src/config";
import { runIncrementalSync } from "../src/services/drive-sync";

export const cron = "*/15 * * * *";

export default defineScheduled(async (_, env) => {
  const drives = getDrives(env);
  const results = await Promise.allSettled(
    drives.map((drive) => runIncrementalSync(drive.idx, env)),
  );

  for (const [i, result] of results.entries()) {
    if (result.status !== "rejected") continue;

    const drive = drives[i];
    console.error(`[cron] sync failed for drive ${drive.idx}:`, result.reason);
  }
});
