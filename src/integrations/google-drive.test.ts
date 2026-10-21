/// <reference types="vite/client" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getRootId, listDriveFolder, resolveFolderId } from "./google-drive";
import { FakeDrive, file } from "../test-support/fake-drive";
import { bindings } from "../test-support/platform";

const drives = [
  {
    name: "Mine",
    kind: "my_drive",
    rootId: "root",
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
  },
  {
    name: "Team",
    kind: "shared_drive",
    rootId: "team-id",
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
  },
  {
    name: "Shared",
    kind: "folder",
    rootId: "folder-id",
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
  },
];

let env: Parameters<typeof resolveFolderId>[2];
let upstream: ReturnType<typeof vi.fn>;

function stubGoogle(rootStatus = 200) {
  upstream = vi.fn(async (input: string | URL) => {
    const url = new URL(input);

    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }

    if (url.pathname.endsWith("/files/root")) {
      return rootStatus === 200
        ? Response.json({ id: "0ARealRoot" })
        : new Response("no", { status: rootStatus });
    }

    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", upstream);
}

function filesRootCalls() {
  return upstream.mock.calls.filter(([url]) => String(url).includes("/files/root"));
}

beforeAll(() => {
  env = { ...bindings(), DRIVES: JSON.stringify(drives) } as typeof env;
});

beforeEach(() => {
  stubGoogle();
});

afterEach(async () => {
  vi.unstubAllGlobals();

  for (const { name } of (await env.KV.list()).keys) {
    await env.KV.delete(name);
  }
});

describe("resolveFolderId", () => {
  it("resolves the root alias to the real ID and caches it for the drive", async () => {
    expect(await resolveFolderId(0, "root", env)).toBe("0ARealRoot");
    expect(await resolveFolderId(0, "root", env)).toBe("0ARealRoot");

    expect(filesRootCalls()).toHaveLength(1);
    expect(await env.KV.get("rootid:0")).toBe("0ARealRoot");
  });

  it("keeps one root ID per drive index", async () => {
    await env.KV.put("rootid:1", "other-root");

    expect(await resolveFolderId(0, "root", env)).toBe("0ARealRoot");
    expect(await resolveFolderId(1, "root", env)).toBe("other-root");
  });

  it.each([
    ["a shared drive", 1, "team-id"],
    ["a folder drive", 2, "folder-id"],
    ["a folder inside My Drive", 0, "some-folder"],
  ])("returns the ID of %s as it is, without asking Google or writing KV", async (_, idx, id) => {
    expect(await resolveFolderId(idx, id, env)).toBe(id);

    expect(upstream).not.toHaveBeenCalled();
    expect((await env.KV.list()).keys).toEqual([]);
  });

  it("throws and caches nothing when Google refuses the lookup", async () => {
    stubGoogle(403);

    await expect(resolveFolderId(0, "root", env)).rejects.toThrow("Root folder lookup failed: 403");
    expect(await env.KV.get("rootid:0")).toBeNull();
  });
});

describe("getRootId", () => {
  it("answers null for the root alias until the root ID is stored, and never asks Google", async () => {
    expect(await getRootId(0, "root", env)).toBeNull();

    await env.KV.put("rootid:0", "0ARealRoot");

    expect(await getRootId(0, "root", env)).toBe("0ARealRoot");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns any other ID as it is", async () => {
    expect(await getRootId(1, "team-id", env)).toBe("team-id");
  });
});

describe("listDriveFolder", () => {
  const ROOT = "0ARealRoot";
  let fake: FakeDrive;

  beforeEach(() => {
    fake = new FakeDrive(ROOT);
    fake.install();
  });

  it("reads every page of a folder", async () => {
    fake.listPageSize = 2;
    fake.put(...["a", "b", "c", "d", "e"].map((n) => file(n, `${n}.txt`, ROOT)));

    const files = await listDriveFolder(0, ROOT, env);

    expect(files.map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("returns a shortcut as itself, with the target it points at", async () => {
    fake.put({
      ...file("link", "shortcut", ROOT),
      shortcutTo: { id: "target", mimeType: "application/pdf" },
    });

    const [listedFile] = await listDriveFolder(0, ROOT, env);

    expect(listedFile).toMatchObject({
      id: "link",
      name: "shortcut",
      shortcutDetails: { targetId: "target", targetMimeType: "application/pdf" },
    });
  });

  it("leaves out the .password file", async () => {
    fake.put(file("a", "a.txt", ROOT), file("p", ".password", ROOT));

    const files = await listDriveFolder(0, ROOT, env);

    expect(files.map((f) => f.id)).toEqual(["a"]);
  });

  it("reads Google on every call and stores nothing in KV", async () => {
    fake.put(file("a", "a.txt", ROOT));

    await listDriveFolder(0, ROOT, env);
    const requests = fake.requests.length;
    await listDriveFolder(0, ROOT, env);

    expect(fake.requests.length).toBeGreaterThan(requests);
    expect((await env.KV.list()).keys.map((key) => key.name)).toEqual(["auth:0:token"]);
  });

  it("throws when Google refuses the listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        new URL(input).hostname === "oauth2.googleapis.com"
          ? Response.json({ access_token: "access", expires_in: 3600 })
          : new Response("no", { status: 500 }),
      ),
    );

    await expect(listDriveFolder(0, ROOT, env)).rejects.toThrow("Drive list failed: 500");
  });
});
