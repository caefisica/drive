import { defineQueue } from "void";
import { queues } from "void/queues";
import { crawlFolder, initializeSyncState } from "../src/services/drive-sync";
import { getDrive } from "../src/config";

type CrawlMessage =
  | { type: "init"; driveIdx: number }
  | { type: "folder"; driveIdx: number; folderId: string; path: string; rootCrawl: boolean };

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

      await initializeSyncState(driveIdx, env);

      await queues.crawl.send({
        type: "folder",
        driveIdx,
        folderId: drive.rootId,
        path: `/${driveIdx}/`,
        rootCrawl: true,
      });

      msg.ack();
    } else if (type === "folder") {
      const { driveIdx, folderId, path } = msg.body;

      const { folderIds } = await crawlFolder(driveIdx, folderId, path, env);

      for (const sub of folderIds) {
        await queues.crawl.send({
          type: "folder",
          driveIdx,
          folderId: sub.id,
          path: sub.path,
          rootCrawl: false,
        });
      }

      msg.ack();
    } else {
      msg.ack();
    }
  }
});
