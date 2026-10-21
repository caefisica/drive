import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { getPlatformProxy } from "wrangler";

import { crawlPending, driveItems, driveRemovals, syncState } from "../../db/schema";
import type * as GoogleDrive from "../integrations/google-drive";
import type { DriveChange, DriveChangesResult, DriveFile } from "../integrations/google-drive";
import { fetchChanges, getStartPageToken, listDriveFolder } from "../integrations/google-drive";
import { crawlFolder, initializeSyncState, runIncrementalSync, syncDrive } from "./drive-sync";
import { applyMigrations } from "../test-support/migrations";

vi.mock("../integrations/google-drive", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleDrive>()),
  fetchChanges: vi.fn(),
  getStartPageToken: vi.fn(),
  listDriveFolder: vi.fn(),
}));

const sendCrawl = vi.hoisted(() => vi.fn());

vi.mock("void/queues", () => ({
  queues: { crawl: { send: sendCrawl } },
}));

type Env = Parameters<typeof runIncrementalSync>[1];

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: Env;

function upsert(id: string, name: string): DriveChange {
  return {
    fileId: id,
    removed: false,
    file: {
      id,
      name,
      mimeType: "text/plain",
      parents: ["root"],
      modifiedTime: "2026-01-01T00:00:00Z",
    },
  };
}

const drive = { name: "d", rootId: "root", clientId: "c", clientSecret: "s", refreshToken: "r" };

function withDrives(count: number): Env {
  return { ...env, DRIVES: JSON.stringify(Array.from({ length: count }, () => drive)) };
}

const FOLDER = "application/vnd.google-apps.folder";

function change(id: string, name: string, parent: string, mimeType = "text/plain"): DriveChange {
  return { fileId: id, removed: false, file: { id, name, mimeType, parents: [parent] } };
}

function listed(id: string, name: string, mimeType = "text/plain"): DriveFile {
  return { id, name, mimeType };
}

function page(changes: DriveChange[], next: Partial<DriveChangesResult>): DriveChangesResult {
  return { changes, ...next };
}

const stateOf = async () =>
  (await drizzle(env.DB).select().from(syncState).where(eq(syncState.driveIdx, 0)))[0];

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: "test/wrangler.jsonc",
    persist: false,
  });
  const bindings = proxy.env as unknown as Env;
  await applyMigrations(bindings.DB);
  env = bindings;
});

afterAll(async () => {
  await proxy.dispose();
});

beforeEach(async () => {
  const db = drizzle(env.DB);
  await db.delete(driveItems);
  await db.delete(driveRemovals);
  await db.delete(syncState);
  await db.delete(crawlPending);
  await db.insert(syncState).values({ driveIdx: 0, pageToken: "start", status: "idle" });
  vi.mocked(fetchChanges).mockReset();
  vi.mocked(listDriveFolder).mockReset();
});

describe("runIncrementalSync", () => {
  it("applies every page of changes and stores the next page token", async () => {
    const db = drizzle(env.DB);
    await db.insert(driveItems).values({
      id: "gone",
      driveIdx: 0,
      name: "gone.txt",
      mimeType: "text/plain",
    });

    vi.mocked(fetchChanges)
      .mockResolvedValueOnce(
        page([upsert("a", "a.txt"), upsert("b", "b.txt"), { fileId: "gone", removed: true }], {
          nextPageToken: "p2",
        }),
      )
      .mockResolvedValueOnce(page([upsert("c", "c.txt")], { newStartPageToken: "next" }));

    await runIncrementalSync(0, env);

    const ids = (await db.select().from(driveItems)).map((row) => row.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);

    const [state] = await db.select().from(syncState).where(eq(syncState.driveIdx, 0));
    expect(state).toMatchObject({ pageToken: "next", status: "idle" });
  });

  it("stores a changed file's own name and parent, whether or not its folder is indexed", async () => {
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page([change("f", "a.txt", "unindexed-folder"), change("g", "b.txt", "root")], {
        newStartPageToken: "next",
      }),
    );

    await runIncrementalSync(0, withDrives(1));

    expect(await drizzle(env.DB).select().from(driveItems)).toEqual([
      expect.objectContaining({ id: "f", name: "a.txt", parentId: "unindexed-folder" }),
      expect.objectContaining({ id: "g", name: "b.txt", parentId: "root" }),
    ]);
  });

  it("stores a changed shortcut the way a crawl does", async () => {
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page(
        [
          {
            fileId: "link",
            removed: false,
            file: {
              id: "link",
              name: "Shared",
              mimeType: "application/vnd.google-apps.shortcut",
              parents: ["root"],
              shortcutDetails: { targetId: "target", targetMimeType: FOLDER },
            },
          },
        ],
        { newStartPageToken: "next" },
      ),
    );

    await runIncrementalSync(0, withDrives(1));

    expect(await drizzle(env.DB).select().from(driveItems)).toMatchObject([
      { id: "link", parentId: "root", mimeType: FOLDER, shortcutTargetId: "target" },
    ]);
  });

  it("follows a rename and a move of a file it already holds", async () => {
    await drizzle(env.DB)
      .insert(driveItems)
      .values({ id: "f", driveIdx: 0, parentId: "a", name: "old.txt", mimeType: "text/plain" });
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page([change("f", "new.txt", "b")], { newStartPageToken: "next" }),
    );

    await runIncrementalSync(0, withDrives(1));

    expect(await drizzle(env.DB).select().from(driveItems)).toEqual([
      expect.objectContaining({ id: "f", name: "new.txt", parentId: "b" }),
    ]);
  });

  it("does not index a password file, and drops a row renamed to that name", async () => {
    await drizzle(env.DB)
      .insert(driveItems)
      .values({ id: "f", driveIdx: 0, parentId: "root", name: "a.txt", mimeType: "text/plain" });
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page([change("f", ".password", "root"), change("g", ".password", "root")], {
        newStartPageToken: "next",
      }),
    );

    await runIncrementalSync(0, withDrives(1));

    expect(await drizzle(env.DB).select().from(driveItems)).toEqual([]);
  });

  it("holds two files of one name in one folder, each under its own ID", async () => {
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page([change("a", "dup.txt", "root"), change("b", "dup.txt", "root")], {
        newStartPageToken: "next",
      }),
    );

    await runIncrementalSync(0, withDrives(1));

    const rows = await drizzle(env.DB).select().from(driveItems);
    expect(rows.map((row) => `${row.id}:${row.name}`).sort((a, b) => a.localeCompare(b))).toEqual([
      "a:dup.txt",
      "b:dup.txt",
    ]);
  });

  it("forgets removals older than an hour and keeps newer ones", async () => {
    const db = drizzle(env.DB);
    const hour = 60 * 60 * 1000;
    await db.insert(driveRemovals).values([
      { id: "stale", driveIdx: 0, feedSeq: 1, removedAt: Date.now() - hour - 1000 },
      { id: "recent", driveIdx: 0, feedSeq: 1, removedAt: Date.now() - hour + 60_000 },
    ]);
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page([{ fileId: "new", removed: true }], { newStartPageToken: "next" }),
    );

    await runIncrementalSync(0, withDrives(1));

    const ids = (await db.select().from(driveRemovals)).map((r) => r.id).sort();
    expect(ids).toEqual(["new", "recent"]);
  });

  it("applies nothing from a page when one of its writes fails", async () => {
    vi.mocked(fetchChanges).mockResolvedValueOnce(
      page([upsert("ok", "ok.txt"), upsert("bad", null as unknown as string)], {
        newStartPageToken: "next",
      }),
    );

    await expect(runIncrementalSync(0, env)).rejects.toThrow();

    const db = drizzle(env.DB);
    expect(await db.select().from(driveItems)).toEqual([]);

    const [state] = await db.select().from(syncState).where(eq(syncState.driveIdx, 0));
    expect(state).toMatchObject({ pageToken: "start", status: "error" });
  });
});

describe("syncDrive", () => {
  beforeEach(() => {
    sendCrawl.mockReset();
  });

  it("queues the crawl init message for a drive that was never indexed", async () => {
    await drizzle(env.DB).delete(syncState);

    await syncDrive(0, withDrives(1));

    expect(sendCrawl).toHaveBeenCalledExactlyOnceWith({ type: "init", driveIdx: 0 });
    expect(fetchChanges).not.toHaveBeenCalled();
  });

  it("syncs changes and queues nothing for a drive that has a page token", async () => {
    vi.mocked(fetchChanges).mockResolvedValueOnce(page([], { newStartPageToken: "next" }));

    await syncDrive(0, withDrives(1));

    expect(fetchChanges).toHaveBeenCalledOnce();
    expect(sendCrawl).not.toHaveBeenCalled();
  });

  it("queues nothing for a drive index that is not configured", async () => {
    await drizzle(env.DB).delete(syncState);

    await syncDrive(3, withDrives(1));

    expect(sendCrawl).not.toHaveBeenCalled();
  });

  describe("while the drive has no page token", () => {
    const HOUR = 60 * 60 * 1000;

    beforeEach(async () => {
      await drizzle(env.DB).delete(syncState);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("records the init as in flight when it queues it", async () => {
      vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });

      await syncDrive(0, withDrives(1));

      expect(await stateOf()).toMatchObject({
        pageToken: null,
        status: "crawling",
        crawlRequestedAt: 1_000_000,
      });
    });

    it("queues the init once across repeated ticks and webhooks", async () => {
      await syncDrive(0, withDrives(1));
      await syncDrive(0, withDrives(1));
      await syncDrive(0, withDrives(1));

      expect(sendCrawl).toHaveBeenCalledOnce();
    });

    it("queues the init once when ticks overlap", async () => {
      await Promise.all([syncDrive(0, withDrives(1)), syncDrive(0, withDrives(1))]);

      expect(sendCrawl).toHaveBeenCalledOnce();
    });

    it("skips while the in-flight init is under an hour old", async () => {
      vi.useFakeTimers({ now: 10 * HOUR, toFake: ["Date"] });
      await drizzle(env.DB)
        .insert(syncState)
        .values({ driveIdx: 0, status: "crawling", crawlRequestedAt: 10 * HOUR - HOUR + 1 });

      await syncDrive(0, withDrives(1));

      expect(sendCrawl).not.toHaveBeenCalled();
    });

    it("queues the init again once the in-flight one is an hour old", async () => {
      vi.useFakeTimers({ now: 10 * HOUR, toFake: ["Date"] });
      await drizzle(env.DB)
        .insert(syncState)
        .values({ driveIdx: 0, status: "crawling", crawlRequestedAt: 10 * HOUR - HOUR });

      await syncDrive(0, withDrives(1));

      expect(sendCrawl).toHaveBeenCalledExactlyOnceWith({ type: "init", driveIdx: 0 });
      expect((await stateOf()).crawlRequestedAt).toBe(10 * HOUR);
    });

    it("queues the init for a row left in error or idle without a token", async () => {
      for (const status of ["error", "idle"] as const) {
        sendCrawl.mockClear();
        await drizzle(env.DB).delete(syncState);
        await drizzle(env.DB).insert(syncState).values({ driveIdx: 0, status });

        await syncDrive(0, withDrives(1));

        expect(sendCrawl).toHaveBeenCalledOnce();
      }
    });

    it("stores the page token and clears the in-flight mark once the init runs", async () => {
      await syncDrive(0, withDrives(1));
      vi.mocked(getStartPageToken).mockResolvedValueOnce("tok");

      await initializeSyncState(0, "real-root", withDrives(1));

      expect(await stateOf()).toMatchObject({
        pageToken: "tok",
        status: "crawling",
        crawlRequestedAt: null,
        crawledAt: null,
      });
    });

    it("leaves the root as the only folder the crawl has yet to read", async () => {
      vi.mocked(getStartPageToken).mockResolvedValue("tok");
      await drizzle(env.DB).insert(crawlPending).values({ driveIdx: 0, folderId: "left-over" });

      await initializeSyncState(0, "real-root", withDrives(1));

      expect(await drizzle(env.DB).select().from(crawlPending)).toEqual([
        { driveIdx: 0, folderId: "real-root" },
      ]);
    });

    it("releases the claim when the queue send fails, so the next tick retries", async () => {
      sendCrawl.mockRejectedValueOnce(new Error("queue down"));

      await expect(syncDrive(0, withDrives(1))).rejects.toThrow("queue down");
      await syncDrive(0, withDrives(1));

      expect(sendCrawl).toHaveBeenCalledTimes(2);
    });
  });
});

describe("crawlFolder", () => {
  it("stores every file of a 200-file listing", async () => {
    const files = Array.from({ length: 200 }, (_, i) => listed(`f${i}`, `f${i}.txt`));
    vi.mocked(listDriveFolder).mockResolvedValueOnce(files);

    const result = await crawlFolder(0, "root", env);

    expect(result.fileCount).toBe(200);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(200);
  });

  it("returns the folders to crawl next and counts the files", async () => {
    vi.mocked(listDriveFolder).mockResolvedValueOnce([
      listed("sub", "sub", FOLDER),
      listed("f", "a.txt"),
    ]);

    expect(await crawlFolder(0, "root", env)).toEqual({ fileCount: 1, folderIds: ["sub"] });
  });

  it("stores a shortcut under its own ID, with the mime type of its target", async () => {
    vi.mocked(listDriveFolder).mockResolvedValueOnce([
      {
        id: "link",
        name: "Shared",
        mimeType: "application/vnd.google-apps.shortcut",
        shortcutDetails: { targetId: "target", targetMimeType: FOLDER },
      },
    ]);

    const result = await crawlFolder(0, "dir", env);

    expect(await drizzle(env.DB).select().from(driveItems)).toMatchObject([
      { id: "link", parentId: "dir", mimeType: FOLDER, shortcutTargetId: "target" },
    ]);
    // The target is read where it lives. Following the shortcut could loop through a parent.
    expect(result.folderIds).toEqual([]);
  });

  it("does not finish the crawl while a subfolder is unread", async () => {
    await initializeSyncState(0, "root", withDrives(1));
    vi.mocked(listDriveFolder).mockResolvedValueOnce([
      listed("a", "a", FOLDER),
      listed("b", "b", FOLDER),
    ]);
    await crawlFolder(0, "root", env);
    expect((await stateOf()).crawledAt).toBeNull();

    vi.mocked(listDriveFolder).mockResolvedValueOnce([]);
    await crawlFolder(0, "a", env);
    expect((await stateOf()).crawledAt).toBeNull();

    vi.mocked(listDriveFolder).mockResolvedValueOnce([listed("c", "c", FOLDER)]);
    await crawlFolder(0, "b", env);
    expect((await stateOf()).crawledAt).toBeNull();

    vi.mocked(listDriveFolder).mockResolvedValueOnce([]);
    await crawlFolder(0, "c", env);
    expect((await stateOf()).crawledAt).not.toBeNull();
    expect(await drizzle(env.DB).select().from(crawlPending)).toEqual([]);
  });

  it("keeps the time the crawl finished when a folder is read again", async () => {
    vi.mocked(listDriveFolder).mockResolvedValue([]);
    await drizzle(env.DB).update(syncState).set({ crawledAt: 5 });

    await crawlFolder(0, "root", env);

    expect((await stateOf()).crawledAt).toBe(5);
  });

  it("queues more subfolders than one statement can bind", async () => {
    await initializeSyncState(0, "root", withDrives(1));
    vi.mocked(listDriveFolder).mockResolvedValueOnce(
      Array.from({ length: 120 }, (_, i) => listed(`d${i}`, `d${i}`, FOLDER)),
    );

    await crawlFolder(0, "root", env);

    expect(await drizzle(env.DB).select().from(crawlPending)).toHaveLength(120);
  });

  it("stores nothing for an empty folder", async () => {
    vi.mocked(listDriveFolder).mockResolvedValueOnce([]);

    expect(await crawlFolder(0, "root", env)).toEqual({ fileCount: 0, folderIds: [] });
    expect(await drizzle(env.DB).select().from(driveItems)).toEqual([]);
  });

  it("updates a re-crawled file that was renamed, moved and resized", async () => {
    const db = drizzle(env.DB);
    const file = { ...listed("f1", "old.txt"), size: 1 };

    vi.mocked(listDriveFolder).mockResolvedValueOnce([file]);
    await crawlFolder(0, "folderA", env);

    vi.mocked(listDriveFolder).mockResolvedValueOnce([
      { ...file, name: "new.md", mimeType: "text/markdown", size: 2 },
    ]);
    await crawlFolder(0, "folderB", env);

    expect(await db.select().from(driveItems)).toEqual([
      {
        id: "f1",
        driveIdx: 0,
        parentId: "folderB",
        name: "new.md",
        mimeType: "text/markdown",
        size: 2,
        modifiedTime: null,
        feedSeq: null,
        shortcutTargetId: null,
      },
    ]);
  });

  describe("files the listing no longer holds", () => {
    const row = (id: string, parentId: string) => ({
      id,
      driveIdx: 0,
      parentId,
      name: `${id}.txt`,
      mimeType: "text/plain",
    });
    const idsOf = async () =>
      (await drizzle(env.DB).select().from(driveItems)).map((r) => r.id).sort();

    it("removes the folder's rows that the listing lacks, and no other folder's", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values([row("kept", "dir"), row("gone", "dir"), row("elsewhere", "other")]);
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listed("kept", "kept.txt")]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["elsewhere", "kept"]);
    });

    it("empties a folder whose listing is empty", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values([row("a", "dir"), row("b", "dir")]);
      vi.mocked(listDriveFolder).mockResolvedValueOnce([]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual([]);
    });

    it("removes more rows than one statement can bind", async () => {
      vi.mocked(listDriveFolder).mockResolvedValueOnce(
        Array.from({ length: 250 }, (_, i) => listed(`f${i}`, `f${i}.txt`)),
      );
      await crawlFolder(0, "dir", env);
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listed("f0", "f0.txt")]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["f0"]);
    });

    it("keeps a row the feed wrote after the listing was read", async () => {
      vi.mocked(listDriveFolder).mockImplementationOnce(async () => {
        const read: DriveFile[] = [];
        vi.mocked(fetchChanges).mockResolvedValueOnce(
          page([change("late", "late.txt", "dir")], { newStartPageToken: "next" }),
        );
        await runIncrementalSync(0, withDrives(1));
        return read;
      });

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["late"]);
    });

    it("does not write back a file the feed removed after the listing was read", async () => {
      await drizzle(env.DB).insert(driveItems).values(row("doomed", "dir"));
      vi.mocked(listDriveFolder).mockImplementationOnce(async () => {
        const read = [listed("doomed", "doomed.txt"), listed("stays", "stays.txt")];
        vi.mocked(fetchChanges).mockResolvedValueOnce(
          page([{ fileId: "doomed", removed: true }], { newStartPageToken: "next" }),
        );
        await runIncrementalSync(0, withDrives(1));
        return read;
      });

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["stays"]);
    });

    it("does not write back a file the feed removed when it was never indexed", async () => {
      vi.mocked(listDriveFolder).mockImplementationOnce(async () => {
        const read = [listed("doomed", "doomed.txt")];
        vi.mocked(fetchChanges).mockResolvedValueOnce(
          page([{ fileId: "doomed", removed: true }], { newStartPageToken: "next" }),
        );
        await runIncrementalSync(0, withDrives(1));
        return read;
      });

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual([]);
    });

    it("writes a file the feed removed and then restored", async () => {
      vi.mocked(listDriveFolder).mockImplementationOnce(async () => {
        const read = [listed("back", "back.txt")];
        vi.mocked(fetchChanges)
          .mockResolvedValueOnce(page([{ fileId: "back", removed: true }], { nextPageToken: "p2" }))
          .mockResolvedValueOnce(
            page([change("back", "back.txt", "dir")], { newStartPageToken: "next" }),
          );
        await runIncrementalSync(0, withDrives(1));
        return read;
      });

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["back"]);
    });

    it("writes a file the feed removed before the counter was read", async () => {
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([{ fileId: "old", removed: true }], { newStartPageToken: "next" }),
      );
      await runIncrementalSync(0, withDrives(1));
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listed("old", "old.txt")]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["old"]);
    });
  });

  describe("against the change feed", () => {
    // A move leaves the modified time as it was, so both sides carry the same one.
    const MODIFIED = "2026-01-01T00:00:00Z";
    const listing = (name: string) => ({ ...listed("f1", name), modifiedTime: MODIFIED });
    const move = (parent: string): DriveChange => ({
      fileId: "f1",
      removed: false,
      file: {
        id: "f1",
        name: "a.txt",
        mimeType: "text/plain",
        parents: [parent],
        modifiedTime: MODIFIED,
      },
    });
    const rowOf = async () => (await drizzle(env.DB).select().from(driveItems))[0];

    async function applyFeed(...changes: DriveChange[]) {
      vi.mocked(fetchChanges).mockResolvedValueOnce(page(changes, { newStartPageToken: "next" }));
      await runIncrementalSync(0, withDrives(1));
    }

    it("keeps a move the feed applied while the listing was being read", async () => {
      vi.mocked(listDriveFolder).mockImplementationOnce(async () => {
        const read = [listing("a.txt")];
        await applyFeed(move("folderB"));
        return read;
      });

      await crawlFolder(0, "folderA", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB", name: "a.txt" });
    });

    it("keeps a move the feed applied to a row the crawl had already written", async () => {
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listing("a.txt")]);
      await crawlFolder(0, "folderA", env);

      vi.mocked(listDriveFolder).mockImplementationOnce(async () => {
        const read = [listing("a.txt")];
        await applyFeed(move("folderB"));
        return read;
      });
      await crawlFolder(0, "folderA", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB" });
    });

    it("applies a listing read after the feed wrote the row", async () => {
      await applyFeed(move("folderA"));
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listing("renamed.txt")]);

      await crawlFolder(0, "folderB", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB", name: "renamed.txt" });
    });

    it("applies a listing to rows the feed has not written", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values({ id: "f1", driveIdx: 0, parentId: "x", name: "old.txt", mimeType: "text/plain" });
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listing("new.txt")]);

      await crawlFolder(0, "folderB", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB", name: "new.txt" });
    });

    it("applies each change in the feed whatever modified time the row holds", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values({
          id: "f1",
          driveIdx: 0,
          parentId: "x",
          name: "newer.txt",
          mimeType: "text/plain",
          modifiedTime: Date.parse("2026-02-01T00:00:00Z"),
        });

      await applyFeed(move("folderB"));

      expect(await rowOf()).toMatchObject({ parentId: "folderB", name: "a.txt" });
    });

    it("applies a listing read after a feed of several pages", async () => {
      vi.mocked(fetchChanges)
        .mockResolvedValueOnce(page([move("folderB")], { nextPageToken: "p2" }))
        .mockResolvedValueOnce(page([upsert("g", "g.txt")], { newStartPageToken: "next" }));
      await runIncrementalSync(0, withDrives(1));
      vi.mocked(listDriveFolder).mockResolvedValueOnce([listing("later.txt")]);

      await crawlFolder(0, "folderC", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderC", name: "later.txt" });
    });
  });
});
