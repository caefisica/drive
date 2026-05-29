import type { CloudEnv } from "void";
import { getDrive } from "../config";

const TOKEN_BASE_URL = "https://oauth2.googleapis.com/token";
const FILES_BASE_URL = "https://www.googleapis.com/drive/v3/files";
const CHANGES_BASE_URL = "https://www.googleapis.com/drive/v3/changes";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  shortcutDetails?: { targetId: string; targetMimeType: string };
};

export type DriveListResult = {
  files: DriveFile[];
  nextPageToken?: string;
};

export type DriveChange = {
  fileId: string;
  removed: boolean;
  file?: DriveFile & { parents?: string[]; trashed?: boolean };
};

export type DriveChangesResult = {
  changes: DriveChange[];
  newStartPageToken?: string;
  nextPageToken?: string;
};

type CachedToken = { token: string; exp: number };

export async function getAccessToken(driveIdx: number, env: CloudEnv["Bindings"]): Promise<string> {
  const cacheKey = `auth:${driveIdx}:token`;
  const cached = await env.KV.get<CachedToken>(cacheKey, "json");
  if (cached && cached.exp > Date.now()) return cached.token;

  const drive = getDrive(driveIdx, env);
  if (!drive) throw new Error(`Drive ${driveIdx} not configured`);

  const res = await fetch(TOKEN_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: drive.clientId,
      client_secret: drive.clientSecret,
      refresh_token: drive.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const { access_token, expires_in } = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const exp = Date.now() + (expires_in - 60) * 1000;
  await env.KV.put(cacheKey, JSON.stringify({ token: access_token, exp }), {
    expirationTtl: expires_in - 60,
  });
  return access_token;
}

export async function listDirectory(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
  pageToken?: string,
): Promise<DriveListResult> {
  const cacheKey = `dir:${driveIdx}:${folderId}:${pageToken ?? "first"}`;
  const cached = await env.KV.get<DriveListResult>(cacheKey, "json");
  if (cached) return cached;

  const drive = getDrive(driveIdx, env);
  const token = await getAccessToken(driveIdx, env);
  const url = new URL(FILES_BASE_URL);
  url.searchParams.set("q", `'${folderId}' in parents and name != '.password' and trashed = false`);
  url.searchParams.set("orderBy", "folder,name,modifiedTime desc");
  url.searchParams.set(
    "fields",
    "nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)",
  );
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (drive?.kind === "shared_drive") {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", drive.rootId);
  }
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);

  const data = (await res.json()) as DriveListResult;

  // Materialize shortcuts as their target to keep downstream handling uniform.
  for (const file of data.files) {
    if (file.mimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails) {
      file.id = file.shortcutDetails.targetId;
      file.mimeType = file.shortcutDetails.targetMimeType;
    }
  }

  // Keep duplicate names addressable in URLs.
  const seenNames = new Map<string, number>();
  for (const file of data.files) {
    seenNames.set(file.name, (seenNames.get(file.name) ?? 0) + 1);
  }
  for (const file of data.files) {
    if ((seenNames.get(file.name) ?? 0) > 1) {
      file.name = `${file.name} (dupID: ${crc32(file.id)})`;
    }
  }

  await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
  return data;
}

export async function getFileMetadata(
  driveIdx: number,
  fileId: string,
  env: CloudEnv["Bindings"],
): Promise<DriveFile> {
  const cacheKey = `meta:${driveIdx}:${fileId}`;
  const cached = await env.KV.get<DriveFile>(cacheKey, "json");
  if (cached) return cached;

  const token = await getAccessToken(driveIdx, env);
  const url = `${FILES_BASE_URL}/${fileId}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`File metadata failed: ${res.status}`);
  const file = (await res.json()) as DriveFile;

  await env.KV.put(cacheKey, JSON.stringify(file), { expirationTtl: 3600 });
  return file;
}

const DUP_RE = /\s+\(dupID:\s*(\d+)\)$/;

export async function resolveSegment(
  driveIdx: number,
  parentId: string,
  segment: string,
  env: CloudEnv["Bindings"],
): Promise<string | null> {
  const cacheKey = `path:${driveIdx}:${parentId}:${encodeURIComponent(segment)}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const dupMatch = DUP_RE.exec(segment);
  const rawName = dupMatch ? segment.slice(0, segment.lastIndexOf(" (dupID:")) : segment;
  const targetCrc = dupMatch ? Number(dupMatch[1]) : null;

  const drive = getDrive(driveIdx, env);
  const token = await getAccessToken(driveIdx, env);
  const url = new URL(FILES_BASE_URL);
  url.searchParams.set(
    "q",
    `'${parentId}' in parents and name = '${rawName.replace(/'/g, "\\'")}' and trashed = false`,
  );
  url.searchParams.set("fields", "files(id,mimeType,shortcutDetails)");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (drive?.kind === "shared_drive") {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", drive.rootId);
  }

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;

  const { files } = (await res.json()) as { files: DriveFile[] };
  if (!files.length) return null;

  let file = files[0];
  if (targetCrc !== null) {
    file = files.find((f) => crc32(f.id) === targetCrc) ?? files[0];
  }
  if (file.mimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails) {
    file.id = file.shortcutDetails.targetId;
  }

  await env.KV.put(cacheKey, file.id, { expirationTtl: 86_400 });
  return file.id;
}

export async function resolvePath(
  driveIdx: number,
  segments: string[],
  env: CloudEnv["Bindings"],
): Promise<{ ids: string[]; finalId: string } | null> {
  const drive = getDrive(driveIdx, env);
  if (!drive) return null;

  let currentId = drive.rootId === "root" ? "root" : drive.rootId;
  const ids: string[] = [currentId];

  for (const segment of segments) {
    const nextId = await resolveSegment(driveIdx, currentId, segment, env);
    if (!nextId) return null;
    ids.push(nextId);
    currentId = nextId;
  }

  return { ids, finalId: currentId };
}

export async function getStartPageToken(
  driveIdx: number,
  env: CloudEnv["Bindings"],
): Promise<string> {
  const drive = getDrive(driveIdx, env);
  const token = await getAccessToken(driveIdx, env);
  const url = new URL(`${CHANGES_BASE_URL}/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  if (drive?.kind === "shared_drive") url.searchParams.set("driveId", drive.rootId);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`startPageToken failed: ${res.status}`);
  const { startPageToken } = (await res.json()) as { startPageToken: string };
  return startPageToken;
}

export async function fetchChanges(
  driveIdx: number,
  pageToken: string,
  env: CloudEnv["Bindings"],
): Promise<DriveChangesResult> {
  const drive = getDrive(driveIdx, env);
  const token = await getAccessToken(driveIdx, env);
  const url = new URL(CHANGES_BASE_URL);
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set(
    "fields",
    "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,parents,trashed))",
  );
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (drive?.kind === "shared_drive") url.searchParams.set("driveId", drive.rootId);

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Changes failed: ${res.status}`);
  return res.json() as Promise<DriveChangesResult>;
}

export const WORKSPACE_EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.spreadsheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.google-apps.drawing": "image/svg+xml",
};

export const WORKSPACE_EXTENSION: Record<string, string> = {
  "application/vnd.google-apps.document": ".docx",
  "application/vnd.google-apps.spreadsheet": ".xlsx",
  "application/vnd.google-apps.presentation": ".pptx",
  "application/vnd.google-apps.drawing": ".svg",
};

export function isWorkspaceFile(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.");
}

export type FileKind =
  | "folder"
  | "video"
  | "audio"
  | "image"
  | "pdf"
  | "code"
  | "markdown"
  | "document"
  | "archive"
  | "other";

export function getFileKind(mimeType: string): FileKind {
  if (mimeType === "application/vnd.google-apps.folder") return "folder";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") return "markdown";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  )
    return "code";
  if (mimeType.startsWith("application/vnd.google-apps.")) return "document";
  if (
    [
      "application/zip",
      "application/x-rar-compressed",
      "application/x-7z-compressed",
      "application/x-tar",
      "application/gzip",
    ].includes(mimeType)
  )
    return "archive";
  return "other";
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(str: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc = CRC32_TABLE[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
