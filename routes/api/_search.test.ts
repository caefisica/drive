/// <reference types="vite/client" />
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudEnv } from "void";
import { getPlatformProxy } from "wrangler";

import { driveItems } from "../../db/schema";
import { signUnlockCookie } from "../../src/services/crypto";

const migrations = import.meta.glob<string>("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let d1: D1Database;
let kv: KVNamespace;
let app: Hono<CloudEnv>;

async function applyMigrations(db: D1Database) {
  for (const path of Object.keys(migrations).sort()) {
    const statements = migrations[path]
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
}

const UNLOCK_SECRET = "test-unlock-secret";

const drive = {
  name: "d",
  rootId: "root",
  clientId: "c",
  clientSecret: "s",
  refreshToken: "r",
};

async function search(q: string, options: { unlocked?: string[]; drive?: number } = {}) {
  const headers: Record<string, string> = {};

  if (options.unlocked) {
    const cookie = await signUnlockCookie(
      options.unlocked.map((f) => ({ d: 0, f })),
      UNLOCK_SECRET,
    );
    headers.cookie = `drive_unlock=${encodeURIComponent(cookie)}`;
  }

  const query =
    `q=${encodeURIComponent(q)}` + (options.drive === undefined ? "" : `&d=${options.drive}`);
  const env = {
    DB: d1,
    DRIVES: JSON.stringify([drive, drive]),
    KV: kv,
    UNLOCK_SECRET,
  };
  const response = await app.request(`/?${query}`, { headers }, env);
  return response.text();
}

async function lock(driveIdx: number, folderId: string) {
  await kv.put(`passwd:${driveIdx}:${folderId}`, "pbkdf2:salt:hash");
}

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: "test/wrangler.jsonc",
    persist: false,
  });
  ({ DB: d1, KV: kv } = proxy.env as unknown as {
    DB: D1Database;
    KV: KVNamespace;
  });
  await applyMigrations(d1);
  const { GET } = await import("./search");
  app = new Hono<CloudEnv>().get("/", async (c) => (await GET(c)) as Response);
});

afterAll(async () => {
  await proxy.dispose();
});

beforeEach(async () => {
  const db = drizzle(d1);
  await db.delete(driveItems);
  await db.insert(driveItems).values(
    ["500", "50%", "axb", "a_b", "a\\b", "abc"].map((name) => ({
      id: `id-${name}`,
      driveIdx: 0,
      name,
      parentId: "root",
      mimeType: "text/plain",
    })),
  );

  for (const { name } of (await kv.list({ prefix: "passwd:" })).keys) {
    await kv.delete(name);
  }

  // The drives are rooted at `root`; the ID Google reports for it is what top-level files name.
  await kv.put("rootid:0", "root");
  await kv.put("rootid:1", "root");
});

// The fixture nests vault/ inside root/ and deep/ inside vault/. Drive 1 reuses the
// vault folder ID, so its file verifies that locks are scoped to a drive.
async function seedTree() {
  const item = (id: string, name: string, parentId: string, mimeType = "text/plain") => ({
    id,
    driveIdx: 0,
    parentId,
    name,
    mimeType,
  });
  const folder = "application/vnd.google-apps.folder";

  await drizzle(d1)
    .insert(driveItems)
    .values([
      item("pub", "tree-public.txt", "root"),
      item("vault", "tree-vault", "root", folder),
      item("inner", "tree-inner.txt", "vault"),
      item("deep", "tree-deep", "vault", folder),
      item("deepest", "tree-deepest.txt", "deep"),
      { ...item("other", "tree-other-drive.txt", "vault"), driveIdx: 1 },
    ]);
}

// Search names every segment by ID because D1 may omit a sibling that Drive has.
const sfx = (id: string) => `%20(dupID%3A%20${id})`;

describe("GET /api/search", () => {
  it("treats % in the query as a literal character", async () => {
    const html = await search("50%");

    expect(html).toContain(">50%</a>");
    expect(html).not.toContain(">500</a>");
  });

  it("treats _ in the query as a literal character", async () => {
    const html = await search("a_b");

    expect(html).toContain(">a_b</a>");
    expect(html).not.toContain(">axb</a>");
  });

  it("treats a backslash in the query as a literal character", async () => {
    const html = await search("a\\b");

    expect(html).toContain(">a\\b</a>");
    expect(html).not.toContain(">abc</a>");
  });

  describe("result links", () => {
    beforeEach(seedTree);

    it("derives each link from the file's chain of folders", async () => {
      const html = await search("tree-");

      expect(html).toContain(`href="/0/tree-public.txt${sfx("pub")}"`);
      expect(html).toContain(`href="/0/tree-vault${sfx("vault")}/"`);
      expect(html).toContain(`href="/0/tree-vault${sfx("vault")}/tree-inner.txt${sfx("inner")}"`);
      expect(html).toContain(
        `href="/0/tree-vault${sfx("vault")}/tree-deep${sfx("deep")}/tree-deepest.txt${sfx("deepest")}"`,
      );
    });

    it("follows a folder that was renamed", async () => {
      await drizzle(d1)
        .update(driveItems)
        .set({ name: "renamed" })
        .where(and(eq(driveItems.id, "vault"), eq(driveItems.driveIdx, 0)));

      const html = await search("tree-");

      expect(html).toContain(
        `href="/0/renamed${sfx("vault")}/tree-deep${sfx("deep")}/tree-deepest.txt${sfx("deepest")}"`,
      );
      expect(html).not.toContain("/0/tree-vault");
    });

    it("tells same-named files apart by ID", async () => {
      await drizzle(d1).insert(driveItems).values({
        id: "twin",
        driveIdx: 0,
        parentId: "root",
        name: "tree-public.txt",
        mimeType: "text/plain",
      });

      const html = await search("tree-public");

      expect(html).toContain(`href="/0/tree-public.txt${sfx("pub")}"`);
      expect(html).toContain(`href="/0/tree-public.txt${sfx("twin")}"`);
    });

    it("still answers, linking to the drives, when Google cannot give the root ID", async () => {
      await kv.delete("rootid:0");
      await kv.delete("rootid:1");
      await kv.delete("auth:0:token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("down", { status: 503 })),
      );

      try {
        const html = await search("tree-public");

        expect(html).toContain("tree-public.txt");
        expect(html).toContain('href="/0/"');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("links a file whose folders are not indexed to its drive", async () => {
      await drizzle(d1).insert(driveItems).values({
        id: "orphan",
        driveIdx: 0,
        parentId: "unindexed",
        name: "tree-orphan.txt",
        mimeType: "text/plain",
      });

      expect(await search("tree-orphan")).toContain('href="/0/"');
    });
  });

  describe("folder passwords", () => {
    beforeEach(seedTree);

    it("lists everything when no folder has a password", async () => {
      const html = await search("tree-");

      for (const name of ["public", "vault", "inner", "deep", "deepest", "other-drive"]) {
        expect(html).toContain(name);
      }
    });

    it("hides names at every depth of a locked folder from an unauthenticated reader", async () => {
      await lock(0, "vault");

      const html = await search("tree-");

      expect(html).toContain("tree-public.txt");
      expect(html).not.toContain("tree-inner.txt");
      expect(html).not.toContain("tree-deep");
      expect(html).not.toContain("tree-deepest.txt");
    });

    it("keeps the locked folder's own entry and other drives visible", async () => {
      await lock(0, "vault");

      const html = await search("tree-");

      expect(html).toContain(">tree-vault</a>");
      expect(html).toContain("tree-other-drive.txt");
    });

    it("hides locked names from a drive-scoped search too", async () => {
      await lock(0, "vault");

      const html = await search("tree-", { drive: 0 });

      expect(html).not.toContain("tree-inner.txt");
    });

    it("shows a locked folder's names once the reader has unlocked it", async () => {
      await lock(0, "vault");

      const html = await search("tree-", { unlocked: ["vault"] });

      expect(html).toContain("tree-inner.txt");
      expect(html).toContain("tree-deepest.txt");
    });

    it("does not treat unlocking an inner folder as unlocking its locked parent", async () => {
      await lock(0, "vault");
      await lock(0, "deep");

      const html = await search("tree-", { unlocked: ["deep"] });

      expect(html).not.toContain("tree-inner.txt");
      expect(html).not.toContain("tree-deepest.txt");
    });

    it("needs every locked ancestor unlocked", async () => {
      await lock(0, "vault");
      await lock(0, "deep");

      const html = await search("tree-", { unlocked: ["vault"] });

      expect(html).toContain("tree-inner.txt");
      expect(html).not.toContain("tree-deepest.txt");
    });

    it("hides a whole drive whose root is locked", async () => {
      await lock(0, "root");

      const html = await search("tree-");

      expect(html).not.toContain("tree-public.txt");
      expect(html).not.toContain("tree-inner.txt");
      expect(html).toContain("tree-other-drive.txt");
    });
  });
});
