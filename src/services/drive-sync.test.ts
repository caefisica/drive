/// <reference types="vite/client" />
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getPlatformProxy } from "wrangler";

import { driveItems, syncState } from "../../db/schema";
import type { DriveChange, DriveChangesResult } from "../integrations/google-drive";
import { fetchChanges, listDirectory } from "../integrations/google-drive";
import { backfillD1Items, crawlFolder, runIncrementalSync } from "./drive-sync";

vi.mock("../integrations/google-drive", () => ({
  fetchChanges: vi.fn(),
  getStartPageToken: vi.fn(),
  listDirectory: vi.fn(),
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

describe("backfillD1Items", () => {
  it("splits a full page of 100 files into statements under D1's bound-parameter limit", async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      id: `f${i}`,
      name: `f${i}.txt`,
      mimeType: "text/plain",
      urlPath: `/0/f${i}.txt`,
    }));

    await backfillD1Items(0, "root", files, env);

    expect(batchSizes).toEqual([9]);
    expect(await drizzle(env.DB).select().from(driveItems)).toHaveLength(100);
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
