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

export const FOLDER_MIME = "application/vnd.google-apps.folder";

// The file that holds a folder's password. Listings, lookups, the index and search all skip it.
export const PASSWORD_FILE = ".password";

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

// Reads every file of a folder from Drive, every page. A shortcut comes back as itself, with its
// `shortcutDetails`. Only the crawl calls this. Pages read the index.
export async function listDriveFolder(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
): Promise<DriveFile[]> {
  const drive = getDrive(driveIdx, env);
  const token = await getAccessToken(driveIdx, env);
  const query = `'${folderId}' in parents and name != '${PASSWORD_FILE}' and trashed = false`;
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(FILES_BASE_URL);
    url.searchParams.set("q", query);
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)",
    );
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (drive?.kind === "shared_drive") {
      url.searchParams.set("corpora", "drive");
      url.searchParams.set("driveId", drive.rootId);
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);

    const page = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return files;
}

const rootIdKey = (driveIdx: number) => `rootid:${driveIdx}`;

// The real ID of a drive's root as the crawl stored it, or null while no crawl has. Rows and change
// feeds match that ID, not the `root` alias. Never reads Google, so a page can call it.
export async function getRootId(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
): Promise<string | null> {
  return folderId === "root" ? env.KV.get(rootIdKey(driveIdx)) : folderId;
}

// Like `getRootId`, and asks Google when the crawl has not stored the ID yet.
export async function resolveFolderId(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
): Promise<string> {
  const cached = await getRootId(driveIdx, folderId, env);
  if (cached) return cached;

  const token = await getAccessToken(driveIdx, env);
  const res = await fetch(`${FILES_BASE_URL}/root?fields=id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Root folder lookup failed: ${res.status}`);

  const { id } = (await res.json()) as { id: string };
  await env.KV.put(rootIdKey(driveIdx), id);
  return id;
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
    "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,shortcutDetails,parents,trashed))",
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
  return Object.hasOwn(WORKSPACE_EXPORT, mimeType);
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
  if (mimeType === FOLDER_MIME) return "folder";
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
