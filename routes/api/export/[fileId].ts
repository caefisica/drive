import { defineHandler } from "void";
import {
  getAccessToken,
  WORKSPACE_EXPORT,
  WORKSPACE_EXTENSION,
} from "../../../src/integrations/google-drive";
import { verifyStreamToken } from "../../../src/services/crypto";

export const GET = defineHandler(async (c) => {
  const fileId = c.req.param("fileId");
  if (!fileId) return c.json({ error: "not found" }, 404);
  const driveIdx = parseInt(c.req.query("d") ?? "0", 10);
  const token = c.req.query("t") ?? "";

  if (!(await verifyStreamToken(token, fileId, driveIdx, c.env.STREAM_SECRET))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const accessToken = await getAccessToken(driveIdx, c.env);
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!metaRes.ok) return c.json({ error: "file not found" }, 404);

  const { name, mimeType } = (await metaRes.json()) as { name: string; mimeType: string };
  const exportMimeType = WORKSPACE_EXPORT[mimeType];
  if (!exportMimeType) return c.json({ error: "not exportable" }, 400);

  const ext = WORKSPACE_EXTENSION[mimeType] ?? "";
  const upstream = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!upstream.ok) return c.json({ error: "export failed" }, 502);

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": exportMimeType,
      "Content-Disposition": `attachment; filename="${name}${ext}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});
