import { defineHandler } from "void";
import {
  verifyPassword,
  signUnlockCookie,
  verifyUnlockCookie,
  type UnlockEntry,
} from "../../src/services/crypto";

export const POST = defineHandler(async (c) => {
  const body = (await c.req.json()) as { driveIdx?: number; folderId?: string; password?: string };

  if (typeof body.driveIdx !== "number" || !body.folderId || !body.password) {
    return c.json({ error: "invalid request" }, 400);
  }

  const { driveIdx, folderId, password } = body;

  const hash = await c.env.KV.get(`passwd:${driveIdx}:${folderId}`);
  if (!hash) {
    return c.json({ error: "no password set for this folder" }, 404);
  }

  const valid = await verifyPassword(password, hash);
  if (!valid) {
    return c.json({ error: "incorrect password" }, 401);
  }

  const existing = await (async () => {
    const cookie = c.req.header("cookie") ?? "";
    const match = /(?:^|;\s*)drive_unlock=([^;]+)/.exec(cookie);
    if (!match) return [] as UnlockEntry[];
    const parsed = await verifyUnlockCookie(decodeURIComponent(match[1]), c.env.UNLOCK_SECRET);
    return parsed?.u ?? [];
  })();

  const already = existing.some((u) => u.d === driveIdx && u.f === folderId);
  const entries: UnlockEntry[] = already ? existing : [...existing, { d: driveIdx, f: folderId }];

  const cookieValue = await signUnlockCookie(entries, c.env.UNLOCK_SECRET);

  c.header(
    "Set-Cookie",
    `drive_unlock=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );

  return c.json({ ok: true });
});
