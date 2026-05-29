import { defineScheduled } from "void";
import { runIncrementalSync } from "../src/services/drive-sync";
import { getDrives } from "../src/config";

export const cron = "*/15 * * * *";

export default defineScheduled(async (_controller, env) => {
  const drives = getDrives(env);
  for (const drive of drives) {
    try {
      await runIncrementalSync(drive.idx, env);
    } catch (err) {
      console.error(`[cron] sync failed for drive ${drive.idx}:`, err);
    }
  }
});
