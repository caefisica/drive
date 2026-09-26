import { defineHandler } from "void";
import type { InferProps, CloudEnv } from "void";
import MarkdownIt from "markdown-it";
import { codeToHtml } from "shiki";

import { getDrives } from "../src/config";
import {
  getAccessToken,
  getFileKind,
  getFileMetadata,
  isWorkspaceFile,
  listDirectory,
  resolvePath,
  WORKSPACE_EXTENSION,
} from "../src/integrations/google-drive";
import { signStreamToken, verifyUnlockCookie, type UnlockEntry } from "../src/services/crypto";
import { backfillD1Items } from "../src/services/drive-sync";

export type Props = InferProps<typeof loader>;

function parsePath(
  raw: string,
): { driveIdx: number; segments: string[]; isDirectory: boolean } | null {
  const cleaned = raw.replace(/^\//, "");
  const parts = cleaned.split("/").filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const driveIdx = parseInt(parts[0], 10);

  if (isNaN(driveIdx)) {
    return null;
  }

  const segments = parts.slice(1).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });

  const isDirectory = raw.endsWith("/") || segments.length === 0;

  return { driveIdx, segments, isDirectory };
}

async function getUnlockedFolders(
  c: { req: { header: (key: string) => string | undefined } },
  secret: string,
): Promise<UnlockEntry[]> {
  const cookie = c.req.header("cookie") ?? "";
  const match = /(?:^|;\s*)drive_unlock=([^;]+)/.exec(cookie);

  if (!match) {
    return [];
  }

  const parsed = await verifyUnlockCookie(decodeURIComponent(match[1]), secret);

  return parsed?.u ?? [];
}

async function checkFolderPassword(
  driveIdx: number,
  ancestorIds: string[],
  unlockedFolders: UnlockEntry[],
  env: CloudEnv["Bindings"],
): Promise<{ locked: true; folderId: string } | null> {
  const hashes = await Promise.all(
    ancestorIds.map((folderId) => env.KV.get(`passwd:${driveIdx}:${folderId}`)),
  );

  for (let i = 0; i < ancestorIds.length; i++) {
    if (!hashes[i]) {
      continue;
    }

    const folderId = ancestorIds[i];
    const isUnlocked = unlockedFolders.some(
      (entry) => entry.d === driveIdx && entry.f === folderId,
    );

    if (!isUnlocked) {
      return { locked: true, folderId };
    }
  }

  return null;
}

function extToLang(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    cpp: "cpp",
    c: "c",
    cs: "csharp",
    java: "java",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };

  return map[ext] ?? "text";
}

export const loader = defineHandler(async (c) => {
  const raw = c.req.param("path") ?? "";
  const parsed = parsePath(raw);

  if (!parsed) {
    return c.json({ error: "not found" }, 404);
  }

  const { driveIdx, segments, isDirectory } = parsed;
  const drives = getDrives(c.env);
  const drive = drives[driveIdx];

  if (!drive) {
    return c.json({ error: "drive not found" }, 404);
  }

  const resolved = await resolvePath(driveIdx, segments, c.env);

  if (!resolved) {
    return c.json({ error: "not found" }, 404);
  }

  const { ids, finalId } = resolved;
  const unlockedFolders = await getUnlockedFolders(c, c.env.UNLOCK_SECRET);
  const locked = await checkFolderPassword(driveIdx, ids, unlockedFolders, c.env);

  if (locked) {
    return {
      type: "locked" as const,
      driveIdx,
      folderId: locked.folderId,
      path: raw,
      drives,
      drive,
      segments,
    };
  }

  if (isDirectory) {
    const result = await listDirectory(driveIdx, finalId, c.env);
    const items = result.files.map((file) => ({
      ...file,
      kind: getFileKind(file.mimeType),
    }));

    // Persist crawl results without delaying the directory response.
    c.executionCtx.waitUntil(
      backfillD1Items(
        driveIdx,
        finalId,
        result.files.map((file) => ({
          ...file,
          urlPath: `/${driveIdx}/${segments.join("/")}/${file.name}`,
        })),
        c.env,
      ),
    );

    return {
      type: "directory" as const,
      drives,
      driveIdx,
      drive,
      path: raw,
      segments,
      items,
      nextPageToken: result.nextPageToken,
    };
  }

  const file = await getFileMetadata(driveIdx, finalId, c.env);
  const kind = getFileKind(file.mimeType);
  const streamToken = await signStreamToken(finalId, driveIdx, c.env.STREAM_SECRET);

  const streamUrl =
    `/api/stream/${finalId}?d=${driveIdx}` + `&t=${encodeURIComponent(streamToken)}`;

  const exportUrl = isWorkspaceFile(file.mimeType)
    ? `/api/export/${finalId}?d=${driveIdx}` + `&t=${encodeURIComponent(streamToken)}`
    : null;

  const exportExt = WORKSPACE_EXTENSION[file.mimeType] ?? "";

  let renderedHtml: string | null = null;

  if (kind === "code" || kind === "markdown") {
    try {
      const token = await getAccessToken(driveIdx, c.env);
      const rawRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${finalId}?alt=media&supportsAllDrives=true`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (rawRes.ok) {
        const text = await rawRes.text();

        if (kind === "markdown") {
          const markdown = new MarkdownIt({
            html: false,
            linkify: true,
            typographer: true,
          });

          renderedHtml = markdown.render(text);
        } else {
          renderedHtml = await codeToHtml(text, {
            lang: extToLang(file.name),
            theme: "github-dark",
          });
        }
      }
    } catch {
      // Preview failure should not prevent the file from being served.
    }
  }

  return {
    type: "file" as const,
    drives,
    driveIdx,
    drive,
    path: raw,
    segments: segments.slice(0, -1),
    file: { ...file, kind },
    streamUrl,
    exportUrl,
    exportExt,
    renderedHtml,
  };
});
