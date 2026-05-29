import { defineHandler } from "void";
import { getAccessToken } from "../../../src/integrations/google-drive";
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
  const range = c.req.header("Range");

  const upstream = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(range ? { Range: range } : {}),
      },
    },
  );

  const headers = new Headers();
  for (const key of ["Content-Type", "Content-Length", "Content-Range", "Last-Modified", "ETag"]) {
    const val = upstream.headers.get(key);
    if (val) headers.set(key, val);
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(upstream.body, { status: upstream.status, headers });
});
