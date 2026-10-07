/// <reference types="vite/client" />
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

import { FakeDrive, file, folder } from "../test-support/fake-drive";
import { listDirectory, resolveFolderId, resolveSegment } from "./google-drive";

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

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
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

beforeAll(async () => {
  proxy = await getPlatformProxy({ persist: false });
  env = { ...(proxy.env as object), DRIVES: JSON.stringify(drives) } as typeof env;
});

afterAll(async () => {
  await proxy.dispose();
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

describe("folder listings and lookups", () => {
  const ROOT = "0ARealRoot";
  let fake: FakeDrive;

  beforeEach(() => {
    fake = new FakeDrive(ROOT);
    fake.install();
  });

  const listed = async (folderId = "root") =>
    (await listDirectory(0, folderId, env)).map(({ id, name, urlName }) => ({ id, name, urlName }));

  describe("listDirectory", () => {
    it("reads every page of a folder", async () => {
      fake.listPageSize = 2;
      fake.put(...["a", "b", "c", "d", "e"].map((n) => file(n, `${n}.txt`, ROOT)));

      expect((await listed()).map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("names the files of a shared name by ID, even when a page boundary separates them", async () => {
      fake.listPageSize = 1;
      fake.put(file("a", "x.txt", ROOT), file("b", "x.txt", ROOT), file("c", "y.txt", ROOT));

      expect(await listed()).toEqual([
        { id: "a", name: "x.txt", urlName: "x.txt (dupID: a)" },
        { id: "b", name: "x.txt", urlName: "x.txt (dupID: b)" },
        { id: "c", name: "y.txt", urlName: "y.txt" },
      ]);
    });

    it("lists a shortcut as its target, under the shortcut's name", async () => {
      fake.put({
        ...file("link", "shortcut", ROOT),
        shortcutTo: { id: "target", mimeType: "application/pdf" },
      });

      const [listedFile] = await listDirectory(0, "root", env);

      expect(listedFile).toMatchObject({
        id: "target",
        mimeType: "application/pdf",
        name: "shortcut",
      });
    });

    it("leaves out the .password file", async () => {
      fake.put(file("a", "a.txt", ROOT), file("p", ".password", ROOT));

      expect((await listed()).map((f) => f.id)).toEqual(["a"]);
    });

    it("answers from the cache for five minutes", async () => {
      fake.put(file("a", "a.txt", ROOT));

      await listed();
      const requests = fake.requests.length;
      await listed();

      expect(fake.requests).toHaveLength(requests);
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

      await expect(listDirectory(0, "root", env)).rejects.toThrow("Drive list failed: 500");
    });
  });

  describe("resolveSegment", () => {
    it("finds the file a plain name belongs to", async () => {
      fake.put(file("a", "a.txt", ROOT), file("b", "b.txt", ROOT));

      expect(await resolveSegment(0, "root", "b.txt", env)).toBe("b");
    });

    it("answers for the folder as it is now, not as an earlier lookup saw it", async () => {
      fake.put(file("a", "x.txt", ROOT));
      expect(await resolveSegment(0, "root", "x.txt", env)).toBe("a");

      fake.put(file("b", "x.txt", ROOT));
      expect(await resolveSegment(0, "root", "x.txt", env)).toBeNull();

      fake.remove("a");
      fake.remove("b");
      expect(await resolveSegment(0, "root", "x.txt", env)).toBeNull();

      fake.put(file("c", "x.txt", ROOT));
      expect(await resolveSegment(0, "root", "x.txt", env)).toBe("c");
    });

    it("finds nothing for a name the folder does not hold", async () => {
      fake.put(file("a", "a.txt", ROOT));

      expect(await resolveSegment(0, "root", "missing.txt", env)).toBeNull();
    });

    it("does not pick one of two files that share a plain name", async () => {
      fake.put(file("a", "x.txt", ROOT), file("b", "x.txt", ROOT));

      expect(await resolveSegment(0, "root", "x.txt", env)).toBeNull();
    });

    it("finds the file whose ID the suffix carries", async () => {
      fake.listPageSize = 1;
      fake.put(file("a", "x.txt", ROOT), file("b", "x.txt", ROOT));

      expect(await resolveSegment(0, "root", "x.txt (dupID: b)", env)).toBe("b");
      expect(await resolveSegment(0, "root", "x.txt (dupID: a)", env)).toBe("a");
    });

    it("finds a file by its suffixed name after its twin is gone", async () => {
      fake.put(file("a", "x.txt", ROOT));

      expect(await resolveSegment(0, "root", "x.txt (dupID: a)", env)).toBe("a");
    });

    it("does not give a suffixed name to a file with another ID", async () => {
      fake.put(file("a", "x.txt", ROOT));

      expect(await resolveSegment(0, "root", "x.txt (dupID: other)", env)).toBeNull();
    });

    it("tells a file named like a suffixed name from the file that name points at", async () => {
      fake.put(file("A", "x", ROOT), file("B", "x", ROOT), file("C", "x (dupID: B)", ROOT));

      expect(await resolveSegment(0, "root", "x (dupID: B)", env)).toBe("B");
      expect(await resolveSegment(0, "root", "x (dupID: B) (dupID: C)", env)).toBe("C");
    });

    it("looks up a name with a quote or a backslash", async () => {
      fake.put(file("q", "it's.txt", ROOT), file("s", "a\\b.txt", ROOT));

      expect(await resolveSegment(0, "root", "it's.txt", env)).toBe("q");
      expect(await resolveSegment(0, "root", "a\\b.txt", env)).toBe("s");
    });

    it("follows a shortcut to its target", async () => {
      fake.put({
        ...file("link", "shortcut", ROOT),
        shortcutTo: { id: "target", mimeType: "application/pdf" },
      });

      expect(await resolveSegment(0, "root", "shortcut", env)).toBe("target");
    });

    it("looks inside the folder it is given", async () => {
      fake.put(folder("sub", "sub", ROOT), file("a", "a.txt", "sub"), file("b", "a.txt", ROOT));

      expect(await resolveSegment(0, "sub", "a.txt", env)).toBe("a");
    });

    it("throws instead of answering not found when Google fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) =>
          new URL(input).hostname === "oauth2.googleapis.com"
            ? Response.json({ access_token: "access", expires_in: 3600 })
            : new Response("no", { status: 503 }),
        ),
      );

      await expect(resolveSegment(0, "root", "a.txt", env)).rejects.toThrow(
        "Drive list failed: 503",
      );
    });
  });

  it("resolves every URL name a listing shows to the file it was shown for", async () => {
    fake.put(
      folder("D1", "Docs", ROOT),
      folder("D2", "Docs", ROOT),
      file("A", "x", ROOT),
      file("B", "x", ROOT),
      file("C", "x (dupID: B)", ROOT),
      file("T", "it's (a)\\b", ROOT),
    );

    for (const { id, urlName } of await listed()) {
      expect(await resolveSegment(0, "root", urlName, env)).toBe(id);
    }
  });
});
