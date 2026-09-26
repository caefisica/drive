/// <reference types="vite/client" />
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudEnv } from "void";
import { getPlatformProxy } from "wrangler";

import { driveItems } from "../../db/schema";

const local = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("void/db", () => ({
  get db() {
    return local.db;
  },
}));

const migrations = import.meta.glob<string>("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let d1: D1Database;
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

async function search(q: string): Promise<string> {
  const response = await app.request(`/?q=${encodeURIComponent(q)}`, {}, { DRIVES: "[]" });
  return response.text();
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ persist: false });
  d1 = (proxy.env as unknown as { DB: D1Database }).DB;
  await applyMigrations(d1);
  local.db = drizzle(d1);

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
});

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
});
