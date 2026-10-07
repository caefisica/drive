/// <reference types="vite/client" />
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

import { driveItems, syncState } from "../db/schema";
import { runIncrementalSync } from "../src/services/drive-sync";
import { itemUrls } from "../src/services/item-urls";
import crawl from "./crawl";

const sendCrawl = vi.hoisted(() => vi.fn());

vi.mock("void/queues", () => ({ queues: { crawl: { send: sendCrawl } } }));

type Env = Parameters<typeof runIncrementalSync>[1];

const migrations = import.meta.glob<string>("../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const FOLDER = "application/vnd.google-apps.folder";
const creds = { clientId: "c", clientSecret: "s", refreshToken: "r" };

const cases = [
  {
    name: "a My Drive rooted at `root`",
    config: { kind: "my_drive", rootId: "root" },
    root: "0ARealRoot",
  },
  { name: "a shared drive", config: { kind: "shared_drive", rootId: "team-id" }, root: "team-id" },
  { name: "a folder", config: { kind: "folder", rootId: "folder-id" }, root: "folder-id" },
];

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: Env;
let changes: unknown[];

function stubGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(input);

      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }

      if (url.pathname.endsWith("/files/root")) return Response.json({ id: "0ARealRoot" });
      if (url.pathname.endsWith("/startPageToken")) return Response.json({ startPageToken: "t0" });
      if (url.pathname.endsWith("/changes")) {
        return Response.json({ changes, newStartPageToken: "t1" });
      }

      const parent = /^'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "")?.[1];
      const files = [
        { id: "docs", name: "docs", mimeType: FOLDER },
        { id: "top", name: "top.txt", mimeType: "text/plain" },
      ];

      return Response.json({ files: parent === "docs" ? [] : files });
    }),
  );
}

async function consume(body: unknown) {
  const ack = vi.fn();

  await crawl({ messages: [{ body, ack }] } as never, env as never);

  expect(ack).toHaveBeenCalledOnce();
}

function messages() {
  return sendCrawl.mock.calls.map(([body]) => body);
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ persist: false });
  const bindings = proxy.env as unknown as Env;

  for (const path of Object.keys(migrations).sort()) {
    for (const statement of migrations[path].split("--> statement-breakpoint")) {
      if (statement.trim()) await bindings.DB.prepare(statement.trim()).run();
    }
  }

  env = bindings;
});

afterAll(async () => {
  await proxy.dispose();
});

beforeEach(async () => {
  stubGoogle();
  changes = [];
  sendCrawl.mockReset();
  await drizzle(env.DB).delete(driveItems);
  await drizzle(env.DB).delete(syncState);
});

afterEach(async () => {
  vi.unstubAllGlobals();

  for (const { name } of (await env.KV.list()).keys) {
    await env.KV.delete(name);
  }
});

describe.each(cases)("crawl of $name", ({ config, root }) => {
  beforeEach(() => {
    env = { ...env, DRIVES: JSON.stringify([{ name: "d", ...creds, ...config }]) };
  });

  it("starts at the ID Google reports as the parent of the top-level files", async () => {
    await consume({ type: "init", driveIdx: 0 });

    expect(messages()).toEqual([{ type: "folder", driveIdx: 0, folderId: root }]);
  });

  it("links top-level files and files the change feed adds there to the drive's root", async () => {
    await consume({ type: "init", driveIdx: 0 });
    await consume(messages()[0]);

    changes = [
      {
        fileId: "later",
        removed: false,
        file: { id: "later", name: "later.txt", mimeType: "text/plain", parents: [root] },
      },
    ];
    await runIncrementalSync(0, env);

    const rows = await drizzle(env.DB).select().from(driveItems);
    const urls = await itemUrls(drizzle(env.DB), rows, env as never);

    expect(Object.fromEntries(urls)).toEqual({
      docs: "/0/docs/",
      top: "/0/top.txt",
      later: "/0/later.txt",
    });
    expect(new Set(rows.map((row) => row.parentId))).toEqual(new Set([root]));
  });
});
