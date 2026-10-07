import { defineHandler } from "void";
import { isDriveIdx } from "../../src/config";
import { verifyPassword, signUnlockCookie, type UnlockEntry } from "../../src/services/crypto";
import { getUnlockedFolders, passwordKey } from "../../src/services/folder-access";

export const POST = defineHandler(async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    driveIdx?: unknown;
    folderId?: unknown;
    password?: unknown;
  } | null;

  if (
    !isDriveIdx(body?.driveIdx) ||
    typeof body.folderId !== "string" ||
    !body.folderId ||
    typeof body.password !== "string" ||
    !body.password
  ) {
    return c.json({ error: "invalid request" }, 400);
  }

  const { driveIdx, folderId, password } = body;

  const hash = await c.env.KV.get(passwordKey(driveIdx, folderId));
  if (!hash) {
    return c.json({ error: "no password set for this folder" }, 404);
  }

  const valid = await verifyPassword(password, hash);
  if (!valid) {
    return c.json({ error: "incorrect password" }, 401);
  }

  const existing = await getUnlockedFolders(c.req.header("cookie"), c.env.UNLOCK_SECRET);

  const already = existing.some((u) => u.d === driveIdx && u.f === folderId);
  const entries: UnlockEntry[] = already ? existing : [...existing, { d: driveIdx, f: folderId }];

  const cookieValue = await signUnlockCookie(entries, c.env.UNLOCK_SECRET);

  c.header(
    "Set-Cookie",
    `drive_unlock=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );

  return c.json({ ok: true });
});
