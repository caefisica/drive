/// <reference types="vite/client" />
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
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
      mimeType: "text/plain",
      urlPath: `/0/${name}`,
    })),
  );

  for (const { name } of (await kv.list({ prefix: "passwd:" })).keys) {
    await kv.delete(name);
  }
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
    urlPath: `/0/${name}`,
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
