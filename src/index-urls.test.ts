/// <reference types="vite/client" />
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
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
import type { CloudEnv } from "void";
import { getPlatformProxy } from "wrangler";

import { driveItems, syncState } from "../db/schema";
import cron from "../crons/sync";
import crawl from "../queues/crawl";
import { resolvePath } from "./integrations/google-drive";
import { itemUrls } from "./services/item-urls";
import { runIncrementalSync } from "./services/drive-sync";
import { FakeDrive, file, folder } from "./test-support/fake-drive";

const local = vi.hoisted(() => ({
  queued: [] as unknown[],
}));

vi.mock("void/queues", () => ({
  queues: { crawl: { send: async (body: unknown) => void local.queued.push(body) } },
}));

const migrations = import.meta.glob<string>("../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const WEBHOOK_SECRET = "test-webhook-secret";
const creds = { name: "d", clientId: "c", clientSecret: "s", refreshToken: "r" };

// The three ways a drive is rooted. `root` is the ID Drive reports as the parent of a
// top-level file, which for My Drive is not the `root` alias the config uses.
const kinds = [
  {
    name: "a My Drive rooted at `root`",
    config: { kind: "my_drive", rootId: "root" },
    root: "0AMine",
  },
  { name: "a shared drive", config: { kind: "shared_drive", rootId: "0ATeam" }, root: "0ATeam" },
  { name: "a folder", config: { kind: "folder", rootId: "1Shared" }, root: "1Shared" },
];

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let d1: D1Database;
let kv: KVNamespace;
let env: Record<string, unknown>;
let fake: FakeDrive;
let webhookApp: Hono<CloudEnv>;
let pathApp: Hono<CloudEnv>;
let homeApp: Hono<CloudEnv>;
let searchApp: Hono<CloudEnv>;

const sfx = (id: string) => `%20(dupID%3A%20${id})`;

// The tree before and after `mutate`, for a drive whose top-level files have parent `root`.
function seed(root: string) {
  fake.put(
    folder("D1", "Docs", root),
    file("A1", "a.txt", "D1"),
    folder("S1", "Sub", "D1"),
    file("N1", "notes.md", "S1"),
    file("T1", "top.txt", root),
  );
}

// Two folders named Docs, two files named a.txt, a subtree renamed and moved to the top level,
// a file renamed, a file named like a suffixed name, and a file that comes and goes.
function mutate(root: string) {
  fake.put(folder("D2", "Docs", root), file("B1", "b.txt", "D2"), file("A2", "a.txt", "D1"));
  fake.rename("S1", "Notes");
  fake.move("S1", root);
  fake.rename("T1", "top2.txt");
  fake.put(file("L1", "x (dupID: z)", root), file("G", "gone.txt", root));
  fake.remove("G");
}

const expectedUrls = {
  D1: `/0/Docs${sfx("D1")}/`,
  D2: `/0/Docs${sfx("D2")}/`,
  A1: `/0/Docs${sfx("D1")}/a.txt${sfx("A1")}`,
  A2: `/0/Docs${sfx("D1")}/a.txt${sfx("A2")}`,
  B1: `/0/Docs${sfx("D2")}/b.txt${sfx("B1")}`,
  S1: `/0/Notes${sfx("S1")}/`,
  N1: `/0/Notes${sfx("S1")}/notes.md${sfx("N1")}`,
  T1: `/0/top2.txt${sfx("T1")}`,
  L1: `/0/x%20(dupID%3A%20z)${sfx("L1")}`,
};

async function consume(body: unknown) {
  const ack = vi.fn();

  await crawl({ messages: [{ body, ack }] } as never, env as never);

  expect(ack).toHaveBeenCalledOnce();
}

// Runs the queue as Cloudflare does: every message of a wave may run at once.
async function drainCrawlQueue() {
  while (local.queued.length > 0) {
    await Promise.all(local.queued.splice(0).map(consume));
  }
}

async function request(app: Hono<CloudEnv>, path: string, init: RequestInit = {}) {
  const waiting: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => waiting.push(promise),
    passThroughOnException() {},
    props: {},
  };

  const response = await app.request(path, init, env, executionCtx);

  await Promise.all(waiting);
  return response;
}

const writers = {
  crawl: async () => {
    local.queued.push({ type: "folder", driveIdx: 0, folderId: fake.rootId });
    await drainCrawlQueue();
  },
  cron: async () => {
    await cron({} as never, env as never, {} as never);
  },
  webhook: async () => {
    const response = await request(webhookApp, "/api/webhook/0", {
      method: "POST",
      headers: { "x-goog-channel-token": WEBHOOK_SECRET },
    });

    expect(response.status).toBe(200);
  },
  browse: async () => {
    await request(pathApp, "/0/");
    await request(pathApp, `/0/Docs${sfx("D1")}/`);
    await request(pathApp, `/0/Docs${sfx("D2")}/`);
  },
};

function seededRandom(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

async function clearKv(prefix?: string) {
  for (const { name } of (await kv.list({ prefix })).keys) {
    await kv.delete(name);
  }
}

async function urlsOfIndex(): Promise<Record<string, string>> {
  const rows = await drizzle(d1).select().from(driveItems);

  return Object.fromEntries(await itemUrls(drizzle(d1), rows, env as never));
}

// The URL names a visitor sees in a folder, from the page loader.
async function listedUrlNames(path: string): Promise<string[]> {
  const response = await request(pathApp, path);
  const props = await response.json<{ items: Array<{ urlName: string }> }>();

  return props.items.map((item) => item.urlName);
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: "test/wrangler.jsonc", persist: false });
  ({ DB: d1, KV: kv } = proxy.env as unknown as { DB: D1Database; KV: KVNamespace });

  for (const path of Object.keys(migrations).sort()) {
    for (const statement of migrations[path].split("--> statement-breakpoint")) {
      if (statement.trim()) await d1.prepare(statement.trim()).run();
    }
  }

  const webhook = await import("../routes/api/webhook/[driveIdx]");
  const search = await import("../routes/api/search");
  const index = await import("../pages/index.server");
  const path = await import("../pages/[...path].server");
  const respond = async (loader: (c: Context<CloudEnv>) => unknown, c: Context<CloudEnv>) => {
    const result = await loader(c);
    return result instanceof Response ? result : c.json(result as object);
  };

  webhookApp = new Hono<CloudEnv>().post(
    "/api/webhook/:driveIdx",
    async (c) => (await webhook.POST(c)) as Response,
  );
  searchApp = new Hono<CloudEnv>().get("/", async (c) => (await search.GET(c)) as Response);
  homeApp = new Hono<CloudEnv>().get("/", (c) => respond(index.loader, c));
  pathApp = new Hono<CloudEnv>().get("/:path{.+}", (c) => respond(path.loader, c));
});

afterAll(async () => {
  await proxy.dispose();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await drizzle(d1).delete(driveItems);
  await drizzle(d1).delete(syncState);
  await clearKv();
  local.queued.length = 0;
});

describe.each(kinds)("the index of $name", ({ config, root }) => {
  beforeEach(() => {
    fake = new FakeDrive(root);
    fake.install();
    env = {
      DRIVES: JSON.stringify([{ ...creds, ...config }]),
      DB: d1,
      KV: kv,
      STREAM_SECRET: "test-stream-secret",
      UNLOCK_SECRET: "test-unlock-secret",
      WEBHOOK_SECRET,
    };
  });

  // The init stores the change token. A crawl of the folders may follow it, and the drive may
  // change while or after it runs.
  async function init({ crawled }: { crawled: boolean }) {
    seed(root);
    await consume({ type: "init", driveIdx: 0 });

    if (crawled) {
      await drainCrawlQueue();
    } else {
      local.queued.length = 0;
    }
  }

  async function expectIndexAndPagesToAgree() {
    const expected: Record<string, string> = expectedUrls;
    const rows = await drizzle(d1).select().from(driveItems);

    expect(rows.map((row) => row.id).sort()).toEqual(Object.keys(expected).sort());
    expect(await urlsOfIndex()).toEqual(expected);

    // Rows hold each file's own name, whatever its URL name is.
    expect(rows.find((row) => row.id === "A1")).toMatchObject({ name: "a.txt", parentId: "D1" });
    expect(rows.find((row) => row.id === "S1")).toMatchObject({ name: "Notes", parentId: root });

    // Every URL leads to the file it was derived for.
    await clearKv("path:");
    for (const [id, url] of Object.entries(expected)) {
      const segments = url.split("/").slice(2).filter(Boolean).map(decodeURIComponent);

      expect(await resolvePath(0, segments, env as never), url).toMatchObject({ finalId: id });
    }

    // The folders list their files by the shortest name that resolves.
    const home = await (await request(homeApp, "/")).json<{ items: Array<{ urlName: string }> }>();
    expect(home.items.map((item) => item.urlName).sort()).toEqual(
      [
        "Docs (dupID: D1)",
        "Docs (dupID: D2)",
        "Notes",
        "top2.txt",
        "x (dupID: z) (dupID: L1)",
      ].sort(),
    );
    expect(await listedUrlNames(`/0/Docs${sfx("D1")}/`)).toEqual([
      "a.txt (dupID: A1)",
      "a.txt (dupID: A2)",
    ]);
  }

  describe.each([
    ["a drive nothing has crawled yet", false],
    ["a drive crawled before the changes", true],
  ])("for %s", (_, crawled) => {
    it.each([0, 1, 2, 3])(
      "converges when the crawl, cron, webhook and browsing run together, order %i",
      async (order) => {
        const random = seededRandom(order);

        await init({ crawled });
        mutate(root);
        await clearKv("dir:");
        fake.delay = () => new Promise((resolve) => setTimeout(resolve, random() * 3));

        await Promise.all(shuffled(Object.values(writers), random).map((write) => write()));
        await runIncrementalSync(0, env as never);

        await expectIndexAndPagesToAgree();
      },
    );
  });

  it("derives the URL of every file below a renamed folder from the one change to the folder", async () => {
    await init({ crawled: true });
    fake.rename("D1", "Papers");

    await runIncrementalSync(0, env as never);

    const urls = await urlsOfIndex();
    expect(urls).toMatchObject({
      D1: `/0/Papers${sfx("D1")}/`,
      A1: `/0/Papers${sfx("D1")}/a.txt${sfx("A1")}`,
      S1: `/0/Papers${sfx("D1")}/Sub${sfx("S1")}/`,
      N1: `/0/Papers${sfx("D1")}/Sub${sfx("S1")}/notes.md${sfx("N1")}`,
      T1: `/0/top.txt${sfx("T1")}`,
    });
  });

  it("derives the URL of every file in a moved folder from the one change to the folder", async () => {
    await init({ crawled: true });
    fake.put(folder("Z", "Zone", root));
    fake.move("S1", "Z");

    await runIncrementalSync(0, env as never);

    expect(await urlsOfIndex()).toMatchObject({
      S1: `/0/Zone${sfx("Z")}/Sub${sfx("S1")}/`,
      N1: `/0/Zone${sfx("Z")}/Sub${sfx("S1")}/notes.md${sfx("N1")}`,
    });
  });

  it("keeps the URL of a file when a twin arrives and when the twin goes", async () => {
    await init({ crawled: true });
    const url = `/0/Docs${sfx("D1")}/a.txt${sfx("A1")}`;
    const resolves = async () =>
      (await resolvePath(0, url.split("/").slice(2).map(decodeURIComponent), env as never))
        ?.finalId;

    expect((await urlsOfIndex()).A1).toBe(url);
    expect(await resolves()).toBe("A1");

    fake.put(file("A2", "a.txt", "D1"));
    await runIncrementalSync(0, env as never);
    expect((await urlsOfIndex()).A1).toBe(url);
    expect(await resolves()).toBe("A1");

    fake.remove("A2");
    await runIncrementalSync(0, env as never);
    expect((await urlsOfIndex()).A1).toBe(url);
    expect(await resolves()).toBe("A1");
  });

  it("lets a file recreated under a deleted file's name take its URL", async () => {
    await init({ crawled: true });
    fake.remove("T1");
    fake.put(file("T2", "top.txt", root));

    await runIncrementalSync(0, env as never);

    expect(await urlsOfIndex()).toMatchObject({ T2: `/0/top.txt${sfx("T2")}` });
    expect(Object.keys(await urlsOfIndex())).not.toContain("T1");
  });

  it("links a file to the drive when a folder on its way up is not indexed", async () => {
    await init({ crawled: false });
    fake.put(file("lost", "lost.txt", "unindexed-folder"));

    await runIncrementalSync(0, env as never);

    expect((await urlsOfIndex()).lost).toBe("/0/");
  });

  it("keeps a move the feed applied while a crawl's listing of the old folder was in flight", async () => {
    await init({ crawled: false });

    // The listing is read before the move and arrives after the feed applied it.
    let release = () => {};
    let reached = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const listing = new Promise<void>((resolve) => (reached = resolve));
    fake.delay = async (url) => {
      if (!url.pathname.endsWith("/files")) return;

      fake.delay = async () => {};
      reached();
      await held;
    };

    const crawling = consume({ type: "folder", driveIdx: 0, folderId: fake.rootId });
    await listing;
    fake.move("T1", "D1");
    await runIncrementalSync(0, env as never);
    release();
    await crawling;

    const rows = await drizzle(d1).select().from(driveItems);
    expect(rows.find((row) => row.id === "T1")).toMatchObject({ parentId: "D1" });
  });

  it("links a file to a URL that resolves while its same-named twin is not indexed", async () => {
    await init({ crawled: true });
    fake.put(file("A2", "a.txt", "D1"));

    const html = await (await request(searchApp, "/?q=a.txt")).text();
    const href = /href="([^"]+)"/.exec(html)![1];
    const segments = href.split("/").slice(2).filter(Boolean).map(decodeURIComponent);

    expect(await resolvePath(0, segments, env as never)).toMatchObject({ finalId: "A1" });
  });

  it("links a folder on the way to a URL that resolves while its twin is not indexed", async () => {
    await init({ crawled: true });
    fake.put(folder("D2", "Docs", root));

    const html = await (await request(searchApp, "/?q=a.txt")).text();
    const href = /href="([^"]+)"/.exec(html)![1];
    const segments = href.split("/").slice(2).filter(Boolean).map(decodeURIComponent);

    expect(await resolvePath(0, segments, env as never)).toMatchObject({ finalId: "A1" });
  });

  it("links a file to its URL in a search result", async () => {
    await init({ crawled: true });
    mutate(root);
    await runIncrementalSync(0, env as never);

    const html = await (await request(searchApp, "/?q=a.txt")).text();

    expect(html).toContain(`href="/0/Docs${sfx("D1")}/a.txt${sfx("A1")}"`);
    expect(html).toContain(`href="/0/Docs${sfx("D1")}/a.txt${sfx("A2")}"`);
  });
});
