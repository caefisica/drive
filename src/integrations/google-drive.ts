import type { CloudEnv } from "void";
import { getDrive } from "../config";
import { parseUrlName, withUrlNames } from "../url-names";

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

// A file of a folder listing, with the name its URL uses.
export type ListedFile = DriveFile & { urlName: string };

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

// Materialize a shortcut as its target to keep downstream handling uniform.
function followShortcut(file: DriveFile): DriveFile {
  if (file.mimeType !== "application/vnd.google-apps.shortcut" || !file.shortcutDetails) {
    return file;
  }

  return {
    ...file,
    id: file.shortcutDetails.targetId,
    mimeType: file.shortcutDetails.targetMimeType,
  };
}

// Reads every page of a files.list query, so the caller sees all the files a folder holds.
async function listAll(
  driveIdx: number,
  query: string,
  fields: string,
  env: CloudEnv["Bindings"],
  orderBy?: string,
): Promise<DriveFile[]> {
  const drive = getDrive(driveIdx, env);
  const token = await getAccessToken(driveIdx, env);
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(FILES_BASE_URL);
    url.searchParams.set("q", query);
    if (orderBy) url.searchParams.set("orderBy", orderBy);
    url.searchParams.set("fields", `nextPageToken,files(${fields})`);
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
    files.push(...page.files.map(followShortcut));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return files;
}

// Home, folder pages and the crawl list a folder only through this function, so a file has one
// URL name everywhere. The whole folder is read at once because a name is shared only in
// relation to every other file of the folder. `fresh` bypasses the cached listing.
export async function listDirectory(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ListedFile[]> {
  const cacheKey = `dir:${driveIdx}:${folderId}`;
  const cached = fresh ? null : await env.KV.get<ListedFile[]>(cacheKey, "json");
  if (cached) return cached;

  const files = withUrlNames(
    await listAll(
      driveIdx,
      `'${folderId}' in parents and name != '.password' and trashed = false`,
      "id,name,mimeType,size,modifiedTime,shortcutDetails",
      env,
      "folder,name,modifiedTime desc",
    ),
  );

  await env.KV.put(cacheKey, JSON.stringify(files), { expirationTtl: 300 });
  return files;
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

// Finds the file a URL segment names, by the rule `urlName` applies to a listing. A plain segment
// names a file only when no sibling shares its name, and a suffixed one names the file whose ID
// it carries. The answer is never cached: it depends on the siblings the folder holds now.
export async function resolveSegment(
  driveIdx: number,
  parentId: string,
  segment: string,
  env: CloudEnv["Bindings"],
): Promise<string | null> {
  const { name, id } = parseUrlName(segment);
  const quoted = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const found = await listAll(
    driveIdx,
    `'${parentId}' in parents and name = '${quoted}' and trashed = false`,
    "id,name,mimeType,shortcutDetails",
    env,
  );
  const siblings = found.filter((file) => file.name === name);
  const file =
    id === null
      ? siblings.length === 1
        ? siblings[0]
        : undefined
      : siblings.find((f) => f.id === id);

  return file?.id ?? null;
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

// Use the real My Drive root ID because rows and change feeds match that ID, not the `root` alias.
export async function resolveFolderId(
  driveIdx: number,
  folderId: string,
  env: CloudEnv["Bindings"],
): Promise<string> {
  if (folderId !== "root") return folderId;

  const cacheKey = `rootid:${driveIdx}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const token = await getAccessToken(driveIdx, env);
  const res = await fetch(`${FILES_BASE_URL}/root?fields=id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Root folder lookup failed: ${res.status}`);

  const { id } = (await res.json()) as { id: string };
  await env.KV.put(cacheKey, id);
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
