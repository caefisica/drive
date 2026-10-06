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

import { driveItems, syncState } from "../../db/schema";
import type { DriveChange, DriveChangesResult } from "../integrations/google-drive";
import { fetchChanges, getStartPageToken, listDirectory } from "../integrations/google-drive";
import {
  backfillD1Items,
  crawlFolder,
  directoryUrlPath,
  initializeSyncState,
  runIncrementalSync,
  syncDrive,
} from "./drive-sync";

vi.mock("../integrations/google-drive", () => ({
  fetchChanges: vi.fn(),
  getStartPageToken: vi.fn(),
  listDirectory: vi.fn(),
}));

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

async function urlPaths(): Promise<Record<string, string | null>> {
  const rows = await drizzle(env.DB).select().from(driveItems);
  return Object.fromEntries(rows.map((row) => [row.id, row.urlPath]));
}

function page(changes: DriveChange[], next: Partial<DriveChangesResult>): DriveChangesResult {
  return { changes, ...next };
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ persist: false });
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
  await db.delete(syncState);
  await db.insert(syncState).values({ driveIdx: 0, pageToken: "start", status: "idle" });
  vi.mocked(fetchChanges).mockReset();
  vi.mocked(listDirectory).mockReset();
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

    expect(batchSizes).toEqual([3, 1]);

    const ids = (await db.select().from(driveItems)).map((row) => row.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);

    const [state] = await db.select().from(syncState).where(eq(syncState.driveIdx, 0));
    expect(state).toMatchObject({ pageToken: "next", status: "idle" });
  });

  describe("url paths", () => {
    const row = (id: string, name: string, parentId: string, urlPath: string | null) => ({
      id,
      driveIdx: 0,
      parentId,
      name,
      mimeType: id.startsWith("dir") ? FOLDER : "text/plain",
      urlPath,
    });

    it("gives a new file the path of its crawled parent folder", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values(row("dir-a", "a", "root", "/0/a/"));
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("n", "new.txt", "dir-a")], { newStartPageToken: "next" }),
      );

      await runIncrementalSync(0, withDrives(1));

      expect(await urlPaths()).toMatchObject({ n: "/0/a/new.txt" });
    });

    it("gives a file in the drive root a path under the drive", async () => {
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("n", "new.txt", "root")], { newStartPageToken: "next" }),
      );

      await runIncrementalSync(0, withDrives(1));

      expect(await urlPaths()).toEqual({ n: "/0/new.txt" });
    });

    it("keeps the search path of a changed file and follows a rename", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values([
          row("dir-a", "a", "root", "/0/a/"),
          row("f1", "same.txt", "dir-a", "/0/a/same.txt"),
          row("f2", "old.txt", "dir-a", "/0/a/old.txt"),
        ]);
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("f1", "same.txt", "dir-a"), change("f2", "renamed.txt", "dir-a")], {
          newStartPageToken: "next",
        }),
      );

      await runIncrementalSync(0, withDrives(1));

      expect(await urlPaths()).toMatchObject({
        f1: "/0/a/same.txt",
        f2: "/0/a/renamed.txt",
      });
    });

    it("keeps the stored path when the parent folder is not indexed", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values(row("f1", "a.txt", "root", "/0/a.txt"));
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("f1", "a.txt", "unknown-folder")], { newStartPageToken: "next" }),
      );

      await runIncrementalSync(0, withDrives(1));

      expect(await urlPaths()).toEqual({ f1: "/0/a.txt" });
    });

    it("resolves a file whose new parent folder arrives later in the same page", async () => {
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("f", "x.txt", "dir-new"), change("dir-new", "docs", "root", FOLDER)], {
          newStartPageToken: "next",
        }),
      );

      await runIncrementalSync(0, withDrives(1));

      expect(await urlPaths()).toEqual({ "dir-new": "/0/docs/", f: "/0/docs/x.txt" });
    });

    it("lets a recreated file take the path of the one it replaces", async () => {
      await drizzle(env.DB)
        .insert(driveItems)
        .values(row("old", "x.txt", "root", "/0/x.txt"));
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("new", "x.txt", "root"), { fileId: "old", removed: true }], {
          newStartPageToken: "next",
        }),
      );

      await runIncrementalSync(0, withDrives(1));

      expect(await urlPaths()).toEqual({ new: "/0/x.txt" });
    });

    it("syncs a page where two files share a name in one folder", async () => {
      vi.mocked(fetchChanges).mockResolvedValueOnce(
        page([change("a", "dup.txt", "root"), change("b", "dup.txt", "root")], {
          newStartPageToken: "next",
        }),
      );

      await runIncrementalSync(0, withDrives(1));

      const paths = Object.values(await urlPaths());
      expect(paths.filter((path) => path === "/0/dup.txt")).toHaveLength(1);
      expect(Object.keys(await urlPaths()).sort()).toEqual(["a", "b"]);
    });
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
    const files = Array.from({ length: 100 }, (_, i) => ({
      id: `f${i}`,
      name: `f${i}.txt`,
      mimeType: "text/plain",
    }));

    await backfillD1Items(0, "root", "/0/", files, env);

    expect(batchSizes).toEqual([9]);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(100);
  });

  it("stores the same paths a crawl does: one slash at the root, a trailing slash on folders", async () => {
    const files = [
      { id: "sub", name: "sub", mimeType: FOLDER },
      { id: "f", name: "a.txt", mimeType: "text/plain" },
    ];

    await backfillD1Items(0, "root", directoryUrlPath(0, []), files, env);

    expect(await urlPaths()).toEqual({ sub: "/0/sub/", f: "/0/a.txt" });
  });

  it("stores nested folder contents under the folder's own path", async () => {
    const files = [{ id: "f", name: "a.txt", mimeType: "text/plain" }];

    await backfillD1Items(0, "dir-b", directoryUrlPath(0, ["a", "b"]), files, env);

    expect(await urlPaths()).toEqual({ f: "/0/a/b/a.txt" });
  });

  it("leaves one entry per file when a crawl and a browse list the same folder", async () => {
    const files = [
      { id: "sub", name: "sub", mimeType: FOLDER },
      { id: "f", name: "a.txt", mimeType: "text/plain" },
    ];
    vi.mocked(listDirectory).mockResolvedValueOnce({ files });

    await backfillD1Items(0, "root", directoryUrlPath(0, []), files, env);
    await crawlFolder(0, "root", "/0/", env);

    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(2);
    expect(await urlPaths()).toEqual({ sub: "/0/sub/", f: "/0/a.txt" });
  });
});

describe("crawlFolder", () => {
  it("stores every file of a 200-file listing page in one D1 batch", async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`,
      name: `f${i}.txt`,
      mimeType: "text/plain",
    }));
    vi.mocked(listDirectory).mockResolvedValueOnce({ files });

    const result = await crawlFolder(0, "root", "/0/", env);

    expect(result.fileCount).toBe(200);
    expect(batchSizes).toEqual([17]);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(200);
  });

  it("updates a re-crawled file that was renamed, moved and resized", async () => {
    const db = drizzle(env.DB);
    const file = { id: "f1", name: "old.txt", mimeType: "text/plain", size: 1 };

    vi.mocked(listDirectory).mockResolvedValueOnce({ files: [file] });
    await crawlFolder(0, "folderA", "/0/a/", env);

    vi.mocked(listDirectory).mockResolvedValueOnce({
      files: [{ ...file, name: "new.md", mimeType: "text/markdown", size: 2 }],
    });
    await crawlFolder(0, "folderB", "/0/b/", env);

    expect(await db.select().from(driveItems)).toEqual([
      {
        id: "f1",
        driveIdx: 0,
        parentId: "folderB",
        name: "new.md",
        mimeType: "text/markdown",
        size: 2,
        modifiedTime: null,
        urlPath: "/0/b/new.md",
      },
    ]);
  });
});
