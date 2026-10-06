import type { CloudEnv } from "void";

import { verifyUnlockCookie, type UnlockEntry } from "./crypto";

const PASSWORD_KEY_PREFIX = "passwd:";

export function passwordKey(driveIdx: number, folderId: string): string {
  return `${PASSWORD_KEY_PREFIX}${driveIdx}:${folderId}`;
}

export async function getUnlockedFolders(
  cookieHeader: string | undefined,
  secret: string,
): Promise<UnlockEntry[]> {
  const match = /(?:^|;\s*)drive_unlock=([^;]+)/.exec(cookieHeader ?? "");

  if (!match) {
    return [];
  }

  const parsed = await verifyUnlockCookie(decodeURIComponent(match[1]), secret);

  return parsed?.u ?? [];
}

function isUnlocked(unlocked: UnlockEntry[], driveIdx: number, folderId: string): boolean {
  return unlocked.some((entry) => entry.d === driveIdx && entry.f === folderId);
}

export async function checkFolderPassword(
  driveIdx: number,
  ancestorIds: string[],
  unlocked: UnlockEntry[],
  env: CloudEnv["Bindings"],
): Promise<{ locked: true; folderId: string } | null> {
  const hashes = await Promise.all(
    ancestorIds.map((folderId) => env.KV.get(passwordKey(driveIdx, folderId))),
  );

  for (let i = 0; i < ancestorIds.length; i++) {
    if (hashes[i] && !isUnlocked(unlocked, driveIdx, ancestorIds[i])) {
      return { locked: true, folderId: ancestorIds[i] };
    }
  }

  return null;
}

export async function listClosedFolders(
  driveIdxs: number[],
  unlocked: UnlockEntry[],
  env: CloudEnv["Bindings"],
): Promise<UnlockEntry[]> {
  const closed: UnlockEntry[] = [];

  for (const d of driveIdxs) {
    const prefix = passwordKey(d, "");
    let cursor: string | undefined;

    do {
      const page = await env.KV.list({ prefix, cursor });

      for (const { name } of page.keys) {
        const f = name.slice(prefix.length);
        if (!isUnlocked(unlocked, d, f)) closed.push({ d, f });
      }

      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  return closed;
}
