import { defineQueue } from "void";
import { queues } from "void/queues";
import { crawlFolder, initializeSyncState } from "../src/services/drive-sync";
import { getDrive } from "../src/config";
import { resolveFolderId } from "../src/integrations/google-drive";

type CrawlMessage =
  | { type: "init"; driveIdx: number }
  | { type: "folder"; driveIdx: number; folderId: string };

export const maxBatchSize = 1;
export const maxBatchTimeout = 30;
export const maxRetries = 3;

export default defineQueue<CrawlMessage>(async (batch, env) => {
  for (const msg of batch.messages) {
    const { type } = msg.body;

    if (type === "init") {
      const { driveIdx } = msg.body;
      const drive = getDrive(driveIdx, env);
      if (!drive) {
        msg.ack();
        continue;
      }

      const rootId = await resolveFolderId(driveIdx, drive.rootId, env);

      await initializeSyncState(driveIdx, env);

      await queues.crawl.send({ type: "folder", driveIdx, folderId: rootId });

      msg.ack();
    } else if (type === "folder") {
      const { driveIdx, folderId } = msg.body;

      const { folderIds } = await crawlFolder(driveIdx, folderId, env);

      for (const id of folderIds) {
        await queues.crawl.send({ type: "folder", driveIdx, folderId: id });
      }

      msg.ack();
    } else {
      msg.ack();
    }
  }
});
