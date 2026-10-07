/// <reference types="vite/client" />
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { CloudEnv } from "void";
import { getPlatformProxy } from "wrangler";

import { signStreamToken } from "../../src/services/crypto";

const STREAM_SECRET = "test-stream-secret";
const UNLOCK_SECRET = "test-unlock-secret";

const drive = {
  name: "d",
  rootId: "root",
  clientId: "c",
  clientSecret: "s",
  refreshToken: "r",
};

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let app: Hono<CloudEnv>;
let upstream: ReturnType<typeof vi.fn>;

function request(path: string, init?: RequestInit) {
  const env = {
    DRIVES: JSON.stringify([drive, drive]),
    KV: (proxy.env as unknown as { KV: KVNamespace }).KV,
    STREAM_SECRET,
    UNLOCK_SECRET,
  };

  return app.request(path, init, env);
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: "test/wrangler.jsonc", persist: false });

  const stream = await import("./stream/[fileId]");
  const exported = await import("./export/[fileId]");
  const unlock = await import("./unlock");

  app = new Hono<CloudEnv>()
    .get("/api/stream/:fileId", async (c) => (await stream.GET(c)) as Response)
    .get("/api/export/:fileId", async (c) => (await exported.GET(c)) as Response)
    .post("/api/unlock", async (c) => (await unlock.POST(c)) as Response);
});

afterAll(async () => {
  await proxy.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGoogle() {
  upstream = vi.fn(async (input: string | URL) => {
    const url = input.toString();

    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }

    return new Response("file bytes", { headers: { "Content-Type": "text/plain" } });
  });
  vi.stubGlobal("fetch", upstream);
}

describe.each(["stream", "export"])("GET /api/%s/:fileId", (route) => {
  it.each([
    ["is missing", ""],
    ["is empty", "&d="],
    ["is not a number", "&d=abc"],
    ["has trailing text", "&d=1x"],
    ["is negative", "&d=-1"],
    ["is fractional", "&d=1.5"],
    ["has a leading zero", "&d=01"],
    ["has more digits than a safe integer", "&d=99999999999999999999999"],
    ["has so many digits that it is Infinity", `&d=${"9".repeat(400)}`],
  ])("answers 400 when d %s, even with a token signed for drive 0", async (_, d) => {
    stubGoogle();
    const token = await signStreamToken("file1", 0, STREAM_SECRET);

    const response = await request(`/api/${route}/file1?t=${encodeURIComponent(token)}${d}`);

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("still answers 403 for a valid d with a bad token", async () => {
    const response = await request(`/api/${route}/file1?d=0&t=bad`);

    expect(response.status).toBe(403);
  });
});

describe("GET /api/stream/:fileId", () => {
  it("streams the file for a token signed for the requested drive", async () => {
    stubGoogle();
    const token = await signStreamToken("file1", 1, STREAM_SECRET);

    const response = await request(`/api/stream/file1?d=1&t=${encodeURIComponent(token)}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file bytes");
  });

  it("refuses a token signed for another drive", async () => {
    const token = await signStreamToken("file1", 0, STREAM_SECRET);

    const response = await request(`/api/stream/file1?d=1&t=${encodeURIComponent(token)}`);

    expect(response.status).toBe(403);
  });
});

describe("POST /api/unlock", () => {
  function unlock(body: string) {
    return request("/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  it.each([
    ["is not JSON", "not json"],
    ["is empty", ""],
    ["is JSON null", "null"],
    ["is a JSON string", '"password"'],
    ["lacks a field", '{"driveIdx":0,"folderId":"f"}'],
    ["has a fractional driveIdx", '{"driveIdx":1.5,"folderId":"f","password":"p"}'],
    ["has a negative driveIdx", '{"driveIdx":-1,"folderId":"f","password":"p"}'],
    [
      "has a driveIdx that overflows to Infinity",
      '{"driveIdx":1e999,"folderId":"f","password":"p"}',
    ],
    ["has a folderId that is not a string", '{"driveIdx":0,"folderId":{"a":1},"password":"p"}'],
    ["has a password that is not a string", '{"driveIdx":0,"folderId":"f","password":["p"]}'],
  ])("answers 400 when the body %s", async (_, body) => {
    const response = await unlock(body);

    expect(response.status).toBe(400);
  });
});
