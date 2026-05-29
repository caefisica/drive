import { defineHandler } from "void";
import type { InferProps } from "void";
import { getDrives } from "../src/config";
import { listDirectory, getFileKind } from "../src/integrations/google-drive";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const drives = getDrives(c.env);
  if (drives.length === 0) {
    return { type: "no-config" as const };
  }

  const drive = drives[0];
  const result = await listDirectory(0, drive.rootId, c.env);

  const items = result.files.map((f) => ({ ...f, kind: getFileKind(f.mimeType) }));

  return {
    type: "directory" as const,
    drives,
    driveIdx: 0,
    drive,
    path: "/",
    segments: [] as string[],
    items,
    nextPageToken: result.nextPageToken,
  };
});
