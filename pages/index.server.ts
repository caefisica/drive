import { defineHandler } from "void";
import type { InferProps } from "void";
import { getDrives, summarizeDrive } from "../src/config";
import { listDirectory, getFileKind } from "../src/integrations/google-drive";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const drives = getDrives(c.env);
  if (drives.length === 0) {
    return { type: "no-config" as const };
  }

  const drive = drives[0];
  const files = await listDirectory(0, drive.rootId, c.env);

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
