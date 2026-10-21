import { defineHandler } from "void";
import type { InferProps } from "void";
import { getDrives, summarizeDrive } from "../src/config";
import { getFileKind } from "../src/integrations/google-drive";
import { checkFolderPassword, getUnlockedFolders } from "../src/services/folder-access";
import { crawledRoot, listFolder, notCrawledResponse } from "../src/services/listing";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const drives = getDrives(c.env);
  if (drives.length === 0) {
    return { type: "no-config" as const };
  }

  const drive = drives[0];
  const root = await crawledRoot(0, c.env);

  if (!root) {
    return notCrawledResponse();
  }

  const unlockedFolders = await getUnlockedFolders(c.req.header("cookie"), c.env.UNLOCK_SECRET);
  const locked = await checkFolderPassword(0, [drive.rootId], unlockedFolders, c.env);

  if (locked) {
    return {
      type: "locked" as const,
      driveIdx: 0,
      folderId: locked.folderId,
      path: "/",
      drives: drives.map(summarizeDrive),
      drive: summarizeDrive(drive),
    };
  }

  const files = await listFolder(0, root, c.env);

  const items = files.map((f) => ({ ...f, kind: getFileKind(f.mimeType) }));

  return {
    type: "directory" as const,
    drives: drives.map(summarizeDrive),
    driveIdx: 0,
    drive: summarizeDrive(drive),
    path: "/",
    segments: [] as string[],
    items,
  };
});
