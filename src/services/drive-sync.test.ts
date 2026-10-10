/// <reference types="vite/client" />
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

import { driveItems, driveRemovals, syncState } from "../../db/schema";
import type * as GoogleDrive from "../integrations/google-drive";
import type { DriveChange, DriveChangesResult, ListedFile } from "../integrations/google-drive";
import {
  fetchChanges,
  getStartPageToken,
  listDirectory,
  resolveFolderId,
} from "../integrations/google-drive";
import {
  backfillD1Items,
  crawlFolder,
  initializeSyncState,
  runIncrementalSync,
  syncDrive,
} from "./drive-sync";

vi.mock("../integrations/google-drive", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleDrive>()),
  fetchChanges: vi.fn(),
  getStartPageToken: vi.fn(),
  listDirectory: vi.fn(),
  resolveFolderId: vi.fn(),
}));

const REAL_ROOT = "0AReAlRoOtId";

// Google reports a My Drive's real root ID where the drive config says `root`.
async function resolveRoot(_driveIdx: number, folderId: string): Promise<string> {
  return folderId === "root" ? REAL_ROOT : folderId;
}

const sendCrawl = vi.hoisted(() => vi.fn());

vi.mock("void/queues", () => ({
  queues: { crawl: { send: sendCrawl } },
}));

type Env = Parameters<typeof runIncrementalSync>[1];

const migrations = import.meta.glob<string>("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: Env;
let batchSizes: number[];

// Delegates to local D1 and records each batch's statement count.
function recordBatches(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          batchSizes.push(statements.length);
          return target.batch(statements);
        };
      }

      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function applyMigrations(db: D1Database) {
  const paths = Object.keys(migrations).sort();

  for (const path of paths) {
    const statements = migrations[path]
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
}

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

function listed(id: string, name: string, urlName = name, mimeType = "text/plain"): ListedFile {
  return { id, name, urlName, mimeType };
}

function page(changes: DriveChange[], next: Partial<DriveChangesResult>): DriveChangesResult {
  return { changes, ...next };
}

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: "test/wrangler.jsonc",
    persist: false,
  });
  const bindings = proxy.env as unknown as Env;
  await applyMigrations(bindings.DB);
  env = { ...bindings, DB: recordBatches(bindings.DB) };
});

afterAll(async () => {
  await proxy.dispose();
});

beforeEach(async () => {
  const db = drizzle(env.DB);
  await db.delete(driveItems);
  await db.delete(driveRemovals);
  await db.delete(syncState);
  await db.insert(syncState).values({ driveIdx: 0, pageToken: "start", status: "idle" });
  vi.mocked(fetchChanges).mockReset();
  vi.mocked(listDirectory).mockReset();
  vi.mocked(resolveFolderId)
    .mockReset()
    .mockImplementation(async (_driveIdx, folderId) => folderId);
  batchSizes = [];
});

describe("runIncrementalSync", () => {
  it("writes each page of changes in one D1 batch", async () => {
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

    // Each batch also takes the next number of the drive's feed counter, and each file it writes
    // clears or records a removal.
    expect(batchSizes).toEqual([8, 4]);

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
    const stateOf = async () =>
      (await drizzle(env.DB).select().from(syncState).where(eq(syncState.driveIdx, 0)))[0];

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

      await initializeSyncState(0, withDrives(1));

      expect(await stateOf()).toMatchObject({
        pageToken: "tok",
        status: "crawling",
        crawlRequestedAt: null,
      });
    });

    it("releases the claim when the queue send fails, so the next tick retries", async () => {
      sendCrawl.mockRejectedValueOnce(new Error("queue down"));

      await expect(syncDrive(0, withDrives(1))).rejects.toThrow("queue down");
      await syncDrive(0, withDrives(1));

      expect(sendCrawl).toHaveBeenCalledTimes(2);
    });
  });
});

describe("backfillD1Items", () => {
  it("splits a full page of 100 files into statements under D1's bound-parameter limit", async () => {
    const files = Array.from({ length: 100 }, (_, i) => listed(`f${i}`, `f${i}.txt`));

    await backfillD1Items(0, "root", files, env);

    expect(batchSizes).toEqual([9]);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(100);
  });

  it("writes a folder of several hundred files in batches of 100 rows", async () => {
    const files = Array.from({ length: 250 }, (_, i) => listed(`f${i}`, `f${i}.txt`));

    await backfillD1Items(0, "root", files, env);

    expect(batchSizes).toEqual([9, 9, 5]);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(250);
  });

  it("stores the real root ID as the parent of a My Drive's top-level files", async () => {
    vi.mocked(resolveFolderId).mockImplementation(resolveRoot);

    await backfillD1Items(0, "root", [listed("f", "a.txt")], env);

    const [row] = await drizzle(env.DB).select().from(driveItems);
    expect(row).toMatchObject({ id: "f", parentId: REAL_ROOT });
  });

  it("stores each file's own name, not the name its URL uses", async () => {
    await backfillD1Items(
      0,
      "dir",
      [listed("a", "x.txt", "x.txt (dupID: a)"), listed("b", "x.txt", "x.txt (dupID: b)")],
      env,
    );

    const rows = await drizzle(env.DB).select().from(driveItems);
    expect(rows.map((row) => [row.id, row.name, row.parentId])).toEqual([
      ["a", "x.txt", "dir"],
      ["b", "x.txt", "dir"],
    ]);
  });

  it("leaves a row it already holds as it is", async () => {
    await drizzle(env.DB).insert(driveItems).values({
      id: "f",
      driveIdx: 0,
      parentId: "new-home",
      name: "new.txt",
      mimeType: "text/plain",
    });

    await backfillD1Items(0, "stale-listing", [listed("f", "old.txt")], env);

    const [row] = await drizzle(env.DB).select().from(driveItems);
    expect(row).toMatchObject({ name: "new.txt", parentId: "new-home" });
  });

  it("leaves one row per file when a crawl and a browse list the same folder", async () => {
    const files = [listed("sub", "sub", "sub", FOLDER), listed("f", "a.txt")];
    vi.mocked(listDirectory).mockResolvedValueOnce(files);

    await backfillD1Items(0, "root", files, env);
    await crawlFolder(0, "root", env);

    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(2);
  });
});

describe("crawlFolder", () => {
  it("stores every file of a 200-file listing, 100 rows to a D1 batch", async () => {
    const files = Array.from({ length: 200 }, (_, i) => listed(`f${i}`, `f${i}.txt`));
    vi.mocked(listDirectory).mockResolvedValueOnce(files);

    const result = await crawlFolder(0, "root", env);

    expect(result.fileCount).toBe(200);
    // Each batch ends with the statement that drops files the feed removed.
    expect(batchSizes).toEqual([10, 10]);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(200);
  });

  it("returns the folders to crawl next and counts the files", async () => {
    vi.mocked(listDirectory).mockResolvedValueOnce([
      listed("sub", "sub", "sub", FOLDER),
      listed("f", "a.txt"),
    ]);

    expect(await crawlFolder(0, "root", env)).toEqual({ fileCount: 1, folderIds: ["sub"] });
  });

  it("stores each file's own name, not the name its URL uses", async () => {
    vi.mocked(listDirectory).mockResolvedValueOnce([
      listed("a", "x.txt", "x.txt (dupID: a)"),
      listed("b", "x.txt", "x.txt (dupID: b)"),
    ]);

    await crawlFolder(0, "dir", env);

    const rows = await drizzle(env.DB).select().from(driveItems);
    expect(rows.map((row) => row.name)).toEqual(["x.txt", "x.txt"]);
  });

  it("stores nothing for an empty folder", async () => {
    vi.mocked(listDirectory).mockResolvedValueOnce([]);

    expect(await crawlFolder(0, "root", env)).toEqual({ fileCount: 0, folderIds: [] });
    expect(batchSizes).toEqual([]);
  });

  it("updates a re-crawled file that was renamed, moved and resized", async () => {
    const db = drizzle(env.DB);
    const file = { ...listed("f1", "old.txt"), size: 1 };

    vi.mocked(listDirectory).mockResolvedValueOnce([file]);
    await crawlFolder(0, "folderA", env);

    vi.mocked(listDirectory).mockResolvedValueOnce([
      { ...file, name: "new.md", urlName: "new.md", mimeType: "text/markdown", size: 2 },
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
      vi.mocked(listDirectory).mockResolvedValueOnce([listed("kept", "kept.txt")]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["elsewhere", "kept"]);
    });

    it("empties a folder whose listing is empty", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values([row("a", "dir"), row("b", "dir")]);
      vi.mocked(listDirectory).mockResolvedValueOnce([]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual([]);
    });

    it("removes more rows than one statement can bind", async () => {
      await backfillD1Items(
        0,
        "dir",
        Array.from({ length: 250 }, (_, i) => listed(`f${i}`, `f${i}.txt`)),
        env,
      );
      vi.mocked(listDirectory).mockResolvedValueOnce([listed("f0", "f0.txt")]);

      await crawlFolder(0, "dir", env);

      expect(await idsOf()).toEqual(["f0"]);
    });

    it("keeps a row the feed wrote after the listing was read", async () => {
      vi.mocked(listDirectory).mockImplementationOnce(async () => {
        const read: ListedFile[] = [];
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
      vi.mocked(listDirectory).mockImplementationOnce(async () => {
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
      vi.mocked(listDirectory).mockImplementationOnce(async () => {
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
      vi.mocked(listDirectory).mockImplementationOnce(async () => {
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
      vi.mocked(listDirectory).mockResolvedValueOnce([listed("old", "old.txt")]);

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
      vi.mocked(listDirectory).mockImplementationOnce(async () => {
        const read = [listing("a.txt")];
        await applyFeed(move("folderB"));
        return read;
      });

      await crawlFolder(0, "folderA", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB", name: "a.txt" });
    });

    it("keeps a move the feed applied to a row the crawl had already written", async () => {
      vi.mocked(listDirectory).mockResolvedValueOnce([listing("a.txt")]);
      await crawlFolder(0, "folderA", env);

      vi.mocked(listDirectory).mockImplementationOnce(async () => {
        const read = [listing("a.txt")];
        await applyFeed(move("folderB"));
        return read;
      });
      await crawlFolder(0, "folderA", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB" });
    });

    it("applies a listing read after the feed wrote the row", async () => {
      await applyFeed(move("folderA"));
      vi.mocked(listDirectory).mockResolvedValueOnce([listing("renamed.txt")]);

      await crawlFolder(0, "folderB", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderB", name: "renamed.txt" });
    });

    it("applies a listing to rows the feed has not written", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values({ id: "f1", driveIdx: 0, parentId: "x", name: "old.txt", mimeType: "text/plain" });
      vi.mocked(listDirectory).mockResolvedValueOnce([listing("new.txt")]);

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
      vi.mocked(listDirectory).mockResolvedValueOnce([listing("later.txt")]);

      await crawlFolder(0, "folderC", env);

      expect(await rowOf()).toMatchObject({ parentId: "folderC", name: "later.txt" });
    });
  });
});
