import { vi } from "vite-plus/test";

import { FOLDER_MIME } from "../integrations/google-drive";

export type FakeFile = {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  size?: number;
  modifiedTime?: string;
  shortcutTo?: { id: string; mimeType: string };
};

export const file = (id: string, name: string, parent: string): FakeFile => ({
  id,
  name,
  mimeType: "text/plain",
  parent,
});

export const folder = (id: string, name: string, parent: string): FakeFile => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  parent,
});

// The Google endpoints the app calls, served from memory. Every change is logged in order, and the
// change feed replays that log from a page token, as Drive does.
export class FakeDrive {
  readonly files = new Map<string, FakeFile>();
  private readonly log: string[] = [];

  // Awaited before each request is answered, so a test can vary how requests interleave.
  delay: () => Promise<void> = async () => {};
  listPageSize = 1000;
  changesPageSize = 100;
  requests: URL[] = [];

  // `rootId` is the ID Drive reports as the parent of top-level files.
  constructor(readonly rootId: string) {}

  put(...files: FakeFile[]) {
    for (const entry of files) {
      this.files.set(entry.id, entry);
      this.log.push(entry.id);
    }
  }

  rename(id: string, name: string) {
    this.put({ ...this.files.get(id)!, name });
  }

  move(id: string, parent: string) {
    this.put({ ...this.files.get(id)!, parent });
  }

  remove(id: string) {
    this.files.delete(id);
    this.log.push(id);
  }

  install() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        this.requests.push(url);
        await this.delay();

        return this.answer(url);
      }),
    );
  }

  private answer(url: URL): Response {
    const { pathname, searchParams } = url;

    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }

    if (pathname.endsWith("/files/root")) return Response.json({ id: this.rootId });
    if (pathname.endsWith("/startPageToken")) {
      return Response.json({ startPageToken: String(this.log.length) });
    }
    if (pathname.endsWith("/changes")) return this.changes(Number(searchParams.get("pageToken")));
    if (pathname.endsWith("/files")) return this.list(searchParams);

    const found = this.files.get(pathname.split("/").pop()!);

    return found ? Response.json(this.describe(found)) : new Response("not found", { status: 404 });
  }

  private describe(entry: FakeFile) {
    return {
      id: entry.id,
      name: entry.name,
      mimeType: entry.shortcutTo ? "application/vnd.google-apps.shortcut" : entry.mimeType,
      size: entry.size,
      modifiedTime: entry.modifiedTime,
      shortcutDetails: entry.shortcutTo && {
        targetId: entry.shortcutTo.id,
        targetMimeType: entry.shortcutTo.mimeType,
      },
    };
  }

  private list(params: URLSearchParams): Response {
    const query = params.get("q") ?? "";
    const parent = /^'([^']+)' in parents/.exec(query)?.[1];
    const named = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, "$1");

    const matches = [...this.files.values()]
      .filter((entry) => entry.parent === (parent === "root" ? this.rootId : parent))
      .filter((entry) => named === undefined || entry.name === named)
      .filter((entry) => !query.includes("name != '.password'") || entry.name !== ".password")
      .sort(
        (a, b) =>
          Number(b.mimeType === FOLDER_MIME) - Number(a.mimeType === FOLDER_MIME) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );

    const start = Number(params.get("pageToken") ?? 0);
    const size = Math.min(Number(params.get("pageSize")), this.listPageSize);
    const page = matches.slice(start, start + size);

    return Response.json({
      files: page.map((entry) => this.describe(entry)),
      nextPageToken: start + size < matches.length ? String(start + size) : undefined,
    });
  }

  private changes(from: number): Response {
    const page = this.log.slice(from, from + this.changesPageSize);
    const end = from + page.length;

    return Response.json({
      changes: page.map((id) => {
        const entry = this.files.get(id);

        return entry
          ? {
              fileId: id,
              removed: false,
              file: { ...this.describe(entry), parents: [entry.parent] },
            }
          : { fileId: id, removed: true };
      }),
      ...(end < this.log.length
        ? { nextPageToken: String(end) }
        : { newStartPageToken: String(this.log.length) }),
    });
  }
}
