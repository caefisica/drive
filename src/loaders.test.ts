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

import { drizzle } from "drizzle-orm/d1";

import { driveItems, syncState } from "../db/schema";
import { signUnlockCookie } from "./services/crypto";
import { applyMigrations } from "./test-support/migrations";

vi.mock("void/queues", () => ({ queues: { crawl: { send: vi.fn() } } }));

const SECRETS = ["client-secret-zero", "refresh-token-zero", "client-secret-one", "refresh-one"];
const UNLOCK_SECRET = "test-unlock-secret";

const drives = [
  {
    name: "Mine",
    kind: "my_drive",
    rootId: "root",
    clientId: "client-id-zero",
    clientSecret: SECRETS[0],
    refreshToken: SECRETS[1],
  },
  {
    name: "Shared",
    kind: "shared_drive",
    rootId: "shared-root",
    clientId: "client-id-one",
    clientSecret: SECRETS[2],
    refreshToken: SECRETS[3],
  },
];

const FOLDER = "application/vnd.google-apps.folder";
const ROOT = "0AMineRoot";

// The index as a finished crawl leaves it, for the drive at index 0.
const children: Record<string, Array<{ id: string; name: string; mimeType: string }>> = {
  [ROOT]: [
    { id: "docs", name: "docs", mimeType: FOLDER },
    { id: "vault", name: "vault", mimeType: FOLDER },
  ],
  docs: [
    { id: "readme", name: "readme.txt", mimeType: "text/plain" },
    { id: "notes", name: "notes", mimeType: "application/vnd.google-apps.document" },
    { id: "survey", name: "survey", mimeType: "application/vnd.google-apps.form" },
    { id: "secret", name: ".password", mimeType: "text/plain" },
  ],
};

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let kv: KVNamespace;
let d1: D1Database;
let indexApp: Hono<CloudEnv>;
let pathApp: Hono<CloudEnv>;

// Every folder page is answered from the index, so Google serves only the preview of a file.
function stubGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(input);

      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }

      return new Response("hello");
    }),
  );
}

async function seedIndex({ crawled }: { crawled: boolean }) {
  const db = drizzle(d1);

  await db
    .insert(driveItems)
    .values(
      Object.entries(children).flatMap(([parentId, items]) =>
        items.map((item) => ({ ...item, mimeType: item.mimeType, driveIdx: 0, parentId })),
      ),
    );

  if (crawled) {
    await db.insert(syncState).values({ driveIdx: 0, crawledAt: 1 });
    await kv.put("rootid:0", ROOT);
  }
}

function recordPuts() {
  const puts: string[] = [];
  const recording = new Proxy(kv, {
    get(target, property) {
      const value = Reflect.get(target, property) as (...args: unknown[]) => unknown;

      if (property === "put") {
        return (key: string, ...rest: unknown[]) => {
          puts.push(key);
          return value.call(target, key, ...rest);
        };
      }

      return value.bind(target);
    },
  });

  return { kv: recording, puts };
}

async function render(app: Hono<CloudEnv>, path: string, cookie?: string, bindings = kv) {
  const env = {
    DRIVES: JSON.stringify(drives),
    DB: d1,
    KV: bindings,
    STREAM_SECRET: "test-stream-secret",
    UNLOCK_SECRET,
  };
  const waiting: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => waiting.push(promise),
    passThroughOnException() {},
    props: {},
  };

  const response = await app.request(
    path,
    { headers: cookie ? { cookie } : {} },
    env,
    executionCtx,
  );

  await Promise.allSettled(waiting);
  return response;
}

// Every `drive` and `drives` prop is one drive's public part, with nothing else.
function expectOnlyPublicDrives(props: Record<string, unknown>) {
  const sent = [props.drive, ...(props.drives as unknown[])] as Array<Record<string, unknown>>;

  for (const entry of sent) {
    expect(
      Object.keys(entry)
        .sort()
        .filter((key) => key !== "kind"),
    ).toEqual(["idx", "name"]);
  }
}

function expectNoSecrets(props: unknown) {
  const json = JSON.stringify(props);

  for (const secret of [...SECRETS, "client-id-zero", "client-id-one", "shared-root"]) {
    expect(json).not.toContain(secret);
  }
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: "test/wrangler.jsonc", persist: false });
  ({ DB: d1, KV: kv } = proxy.env as unknown as { DB: D1Database; KV: KVNamespace });
  await applyMigrations(d1);

  const index = await import("../pages/index.server");
  const path = await import("../pages/[...path].server");
  const respond = async (loader: (c: Context<CloudEnv>) => unknown, c: Context<CloudEnv>) => {
    const result = await loader(c);
    return result instanceof Response ? result : c.json(result as object);
  };

  indexApp = new Hono<CloudEnv>().get("/", (c) => respond(index.loader, c));
  pathApp = new Hono<CloudEnv>().get("/:path{.+}", (c) => respond(path.loader, c));
});

afterAll(async () => {
  await proxy.dispose();
});

beforeEach(async () => {
  stubGoogle();
  await seedIndex({ crawled: true });
  await kv.put("passwd:0:vault", "pbkdf2:salt:hash");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await drizzle(d1).delete(driveItems);
  await drizzle(d1).delete(syncState);

  for (const { name } of (await kv.list()).keys) {
    await kv.delete(name);
  }
});

describe("page loaders", () => {
  it.each([
    { page: "the home page", app: () => indexApp, path: "/", type: "directory" },
    { page: "a directory", app: () => pathApp, path: "/0/docs/", type: "directory" },
    { page: "a file", app: () => pathApp, path: "/0/docs/readme.txt", type: "file" },
    { page: "the password form", app: () => pathApp, path: "/0/vault/", type: "locked" },
    {
      page: "an unlocked folder",
      app: () => pathApp,
      path: "/0/vault/",
      type: "directory",
      unlocked: "vault",
    },
  ])("send only idx, name and kind of each drive for $page", async (c) => {
    const unlockCookie = c.unlocked
      ? await signUnlockCookie([{ d: 0, f: c.unlocked }], UNLOCK_SECRET)
      : undefined;
    const cookie = unlockCookie ? `drive_unlock=${encodeURIComponent(unlockCookie)}` : undefined;
    const props = await (await render(c.app(), c.path, cookie)).json<Record<string, unknown>>();

    expect(props.type).toBe(c.type);
    expectOnlyPublicDrives(props);
    expectNoSecrets(props);
  });

  it("send no drive config when none is configured", async () => {
    const env = { DRIVES: "[]", KV: kv, UNLOCK_SECRET };
    const response = await indexApp.request("/", {}, env);

    expect(await response.json()).toEqual({ type: "no-config" });
  });

  it("show the password form on the home page when the first drive's root is locked", async () => {
    await kv.put("passwd:0:root", "pbkdf2:salt:hash");

    const props = await (await render(indexApp, "/")).json<Record<string, unknown>>();

    expect(props).toMatchObject({ type: "locked", driveIdx: 0, folderId: "root" });
    expect(props).not.toHaveProperty("items");
    expectOnlyPublicDrives(props);
    expectNoSecrets(props);
  });

  it("list the home page once the first drive's root is unlocked", async () => {
    await kv.put("passwd:0:root", "pbkdf2:salt:hash");
    const cookie = await signUnlockCookie([{ d: 0, f: "root" }], UNLOCK_SECRET);

    const response = await render(indexApp, "/", `drive_unlock=${encodeURIComponent(cookie)}`);

    expect(await response.json()).toMatchObject({ type: "directory", driveIdx: 0 });
  });

  it("lock a folder page under a locked drive root", async () => {
    await kv.put("passwd:0:root", "pbkdf2:salt:hash");

    const props = await (await render(pathApp, "/0/docs/")).json<Record<string, unknown>>();

    expect(props).toMatchObject({ type: "locked", folderId: "root" });
  });

  it.each(["/01/", "/1abc/", "/0x1/", "/-0/", "/+0/", "/ 0/", "/0.0/"])(
    "answer 404 for %s, which is not a drive index",
    async (path) => {
      const response = await render(pathApp, path);

      expect(response.status).toBe(404);
    },
  );

  it("answer 404 for a drive index that is not configured", async () => {
    expect((await render(pathApp, "/2/")).status).toBe(404);
  });

  it.each(["/0/docs/.password", "/0/docs/.password%20(dupID:%20secret)"])(
    "answer 404 for %s, the file listings hide",
    async (path) => {
      const response = await render(pathApp, path);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    },
  );

  it.each([
    { page: "the home page", app: () => indexApp, path: "/", names: ["docs", "vault"] },
    {
      page: "a folder page",
      app: () => pathApp,
      path: "/0/docs/",
      names: ["notes", "readme.txt", "survey"],
    },
  ])("list $page from the index, without a KV put or a Google request", async (c) => {
    const recorded = recordPuts();
    const response = await render(c.app(), c.path, undefined, recorded.kv);
    const props = await response.json<{ items: Array<{ name: string }> }>();

    expect(response.status).toBe(200);
    expect(props.items.map((item) => item.name)).toEqual(c.names);
    expect(recorded.puts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { page: "the home page", app: () => indexApp, path: "/" },
    { page: "a folder page", app: () => pathApp, path: "/0/docs/" },
  ])("answer 503 on $page while the drive has no finished crawl", async (c) => {
    await drizzle(d1).delete(syncState);

    const response = await render(c.app(), c.path);

    expect(response.status).toBe(503);
    expect(await response.json<{ error: string }>()).toEqual({
      error: expect.stringContaining("not indexed yet"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offer an export for a Docs file and none for a Form", async () => {
    const doc = await (await render(pathApp, "/0/docs/notes")).json<Record<string, unknown>>();
    const form = await (await render(pathApp, "/0/docs/survey")).json<Record<string, unknown>>();

    expect(doc).toMatchObject({ type: "file", exportExt: ".docx" });
    expect(doc.exportUrl).toMatch(/^\/api\/export\/notes\?d=0&t=/);
    expect(form).toMatchObject({ type: "file", exportUrl: null, exportExt: "" });
  });
});
