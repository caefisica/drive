import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { crawlPending, driveItems, syncState } from "../../db/schema";
import { FOLDER_MIME, resolveFolderId } from "../integrations/google-drive";
import { FakeDrive, file, folder, type FakeFile } from "../test-support/fake-drive";
import { bindings } from "../test-support/platform";
import { crawlFolder, initializeSyncState } from "./drive-sync";
import { crawledRoot, listFolder, resolvePath } from "./listing";

vi.mock("void/queues", () => ({ queues: { crawl: { send: vi.fn() } } }));

const ROOT = "0ARealRoot";
const creds = { name: "d", clientId: "c", clientSecret: "s", refreshToken: "r" };

let env: Parameters<typeof listFolder>[2];
let fake: FakeDrive;

// Runs the crawl as the queue does: from the root, one message per folder.
async function crawlAll() {
  await initializeSyncState(0, ROOT, env);

  const queue = [ROOT];
  while (queue.length > 0) {
    queue.push(...(await crawlFolder(0, queue.shift()!, env)).folderIds);
  }
}

const idsIn = async (folderId: string) => (await listFolder(0, folderId, env)).map((f) => f.id);

const resolve = async (...segments: string[]) =>
  (await resolvePath(0, segments, ROOT, env))?.finalId ?? null;

beforeEach(() => {
  fake = new FakeDrive(ROOT);
  fake.install();
  env = {
    ...bindings(),
    DRIVES: JSON.stringify([{ ...creds, kind: "shared_drive", rootId: ROOT }]),
  } as typeof env;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const db = drizzle(env.DB);
  await db.delete(driveItems);
  await db.delete(syncState);
  await db.delete(crawlPending);
});

describe("crawledRoot", () => {
  it("answers null until the crawl has read every folder", async () => {
    fake.put(folder("D", "Docs", ROOT), file("A", "a.txt", "D"));
    expect(await crawledRoot(0, env)).toBeNull();

    await initializeSyncState(0, ROOT, env);
    expect(await crawledRoot(0, env)).toBeNull();

    const { folderIds } = await crawlFolder(0, ROOT, env);
    expect(await crawledRoot(0, env)).toBeNull();

    await crawlFolder(0, folderIds[0], env);
    expect(await crawledRoot(0, env)).toBe(ROOT);
  });

  it("answers null for a drive that is not configured", async () => {
    expect(await crawledRoot(3, env)).toBeNull();
  });

  it("answers the real root of a My Drive, and null while that root is not stored", async () => {
    const myDrive = {
      ...env,
      DRIVES: JSON.stringify([{ ...creds, kind: "my_drive", rootId: "root" }]),
    };
    await drizzle(myDrive.DB).insert(syncState).values({ driveIdx: 0, crawledAt: 1 });
    await myDrive.KV.delete("rootid:0");

    expect(await crawledRoot(0, myDrive)).toBeNull();

    expect(await resolveFolderId(0, "root", myDrive)).toBe(ROOT);
    expect(await crawledRoot(0, myDrive)).toBe(ROOT);

    await myDrive.KV.delete("rootid:0");
  });
});

describe("listFolder", () => {
  it("lists folders first, then names without regard to case, then the newest file", async () => {
    fake.put(
      file("b", "b.txt", ROOT),
      folder("z", "zeta", ROOT),
      file("A", "A.txt", ROOT),
      folder("y", "Alpha", ROOT),
      { ...file("old", "same", ROOT), modifiedTime: "2026-01-01T00:00:00Z" },
      { ...file("new", "same", ROOT), modifiedTime: "2026-06-01T00:00:00Z" },
    );
    await crawlAll();

    expect(await idsIn(ROOT)).toEqual(["y", "z", "A", "b", "new", "old"]);
  });

  it("lists only the folder it is given", async () => {
    fake.put(folder("D", "Docs", ROOT), file("A", "a.txt", "D"), file("T", "top.txt", ROOT));
    await crawlAll();

    expect(await idsIn("D")).toEqual(["A"]);
  });

  it("gives the files of a shared name a URL name that carries the ID", async () => {
    fake.put(file("a", "x.txt", ROOT), file("b", "x.txt", ROOT), file("c", "y.txt", ROOT));
    await crawlAll();

    expect((await listFolder(0, ROOT, env)).map((f) => [f.id, f.urlName])).toEqual([
      ["a", "x.txt (dupID: a)"],
      ["b", "x.txt (dupID: b)"],
      ["c", "y.txt"],
    ]);
  });

  it("describes a file by its size and its modified time", async () => {
    fake.put({ ...file("a", "a.txt", ROOT), size: 12, modifiedTime: "2026-03-04T05:06:07.000Z" });
    fake.put(file("b", "b.txt", ROOT));
    await crawlAll();

    expect(await listFolder(0, ROOT, env)).toEqual([
      {
        id: "a",
        name: "a.txt",
        mimeType: "text/plain",
        size: 12,
        modifiedTime: "2026-03-04T05:06:07.000Z",
        urlName: "a.txt",
      },
      { id: "b", name: "b.txt", mimeType: "text/plain", urlName: "b.txt" },
    ]);
  });

  it("lists a shortcut under its own ID and name, as a file of its target's type", async () => {
    fake.put(
      { ...file("link", "Shared", ROOT), shortcutTo: { id: "T", mimeType: FOLDER_MIME } },
      file("A", "a.txt", ROOT),
    );
    await crawlAll();

    expect(await listFolder(0, ROOT, env)).toMatchObject([
      { id: "link", name: "Shared", mimeType: FOLDER_MIME },
      { id: "A" },
    ]);
  });

  it("leaves out the .password file", async () => {
    await drizzle(env.DB)
      .insert(driveItems)
      .values([
        { id: "a", driveIdx: 0, parentId: ROOT, name: "a.txt", mimeType: "text/plain" },
        { id: "p", driveIdx: 0, parentId: ROOT, name: ".password", mimeType: "text/plain" },
      ]);

    expect(await idsIn(ROOT)).toEqual(["a"]);
  });

  it("lists nothing for a folder the index does not hold", async () => {
    expect(await idsIn("unknown")).toEqual([]);
  });

  it("lists a drive from the index alone", async () => {
    fake.put(file("a", "a.txt", ROOT));
    await crawlAll();
    const requests = fake.requests.length;

    await listFolder(0, ROOT, env);

    expect(fake.requests).toHaveLength(requests);
  });
});

describe("resolvePath", () => {
  it("finds the file a plain name belongs to", async () => {
    fake.put(file("a", "a.txt", ROOT), file("b", "b.txt", ROOT));
    await crawlAll();

    expect(await resolve("b.txt")).toBe("b");
  });

  it("answers for the folder as it is now", async () => {
    fake.put(file("a", "x.txt", ROOT));
    await crawlAll();
    expect(await resolve("x.txt")).toBe("a");

    fake.put(file("b", "x.txt", ROOT));
    await crawlAll();
    expect(await resolve("x.txt")).toBeNull();

    fake.remove("a");
    fake.remove("b");
    await crawlAll();
    expect(await resolve("x.txt")).toBeNull();

    fake.put(file("c", "x.txt", ROOT));
    await crawlAll();
    expect(await resolve("x.txt")).toBe("c");
  });

  it.each([".password", ".password (dupID: p)"])(
    "finds nothing for %s, the file listings hide",
    async (segment) => {
      await drizzle(env.DB).insert(driveItems).values({
        id: "p",
        driveIdx: 0,
        parentId: ROOT,
        name: ".password",
        mimeType: "text/plain",
      });

      expect(await resolve(segment)).toBeNull();
    },
  );

  it("finds nothing for a name the folder does not hold", async () => {
    fake.put(file("a", "a.txt", ROOT));
    await crawlAll();

    expect(await resolve("missing.txt")).toBeNull();
  });

  it("does not pick one of two files that share a plain name", async () => {
    fake.put(file("a", "x.txt", ROOT), file("b", "x.txt", ROOT));
    await crawlAll();

    expect(await resolve("x.txt")).toBeNull();
  });

  it("finds the file whose ID the suffix carries", async () => {
    fake.put(file("a", "x.txt", ROOT), file("b", "x.txt", ROOT));
    await crawlAll();

    expect(await resolve("x.txt (dupID: b)")).toBe("b");
    expect(await resolve("x.txt (dupID: a)")).toBe("a");
  });

  it("finds a file by its suffixed name after its twin is gone", async () => {
    fake.put(file("a", "x.txt", ROOT));
    await crawlAll();

    expect(await resolve("x.txt (dupID: a)")).toBe("a");
  });

  it("does not give a suffixed name to a file with another ID", async () => {
    fake.put(file("a", "x.txt", ROOT));
    await crawlAll();

    expect(await resolve("x.txt (dupID: other)")).toBeNull();
  });

  it("tells a file named like a suffixed name from the file that name points at", async () => {
    fake.put(file("A", "x", ROOT), file("B", "x", ROOT), file("C", "x (dupID: B)", ROOT));
    await crawlAll();

    expect(await resolve("x (dupID: B)")).toBe("B");
    expect(await resolve("x (dupID: B) (dupID: C)")).toBe("C");
  });

  it("looks up a name with a quote or a backslash", async () => {
    fake.put(file("q", "it's.txt", ROOT), file("s", "a\\b.txt", ROOT));
    await crawlAll();

    expect(await resolve("it's.txt")).toBe("q");
    expect(await resolve("a\\b.txt")).toBe("s");
  });

  it("follows a shortcut to its target and lists the target's files", async () => {
    fake.put(
      folder("T", "Real", "elsewhere"),
      file("A", "a.txt", "T"),
      { ...file("link", "Shortcut", ROOT), shortcutTo: { id: "T", mimeType: FOLDER_MIME } },
      folder("elsewhere", "Elsewhere", ROOT),
    );
    await crawlAll();

    const resolved = await resolvePath(0, ["Shortcut"], ROOT, env);

    expect(resolved).toMatchObject({ ids: ["0ARealRoot", "T"], finalId: "T" });
    expect(await idsIn(resolved!.finalId)).toEqual(["A"]);
  });

  it("resolves a path through folders and describes the last file", async () => {
    fake.put(folder("D", "Docs", ROOT), folder("S", "Sub", "D"), {
      ...file("N", "notes.md", "S"),
      size: 5,
    });
    await crawlAll();

    expect(await resolvePath(0, ["Docs", "Sub", "notes.md"], ROOT, env)).toEqual({
      ids: [ROOT, "D", "S", "N"],
      finalId: "N",
      item: { id: "N", name: "notes.md", mimeType: "text/plain", size: 5, modifiedTime: undefined },
    });
  });

  it("names the root, with no item, for a path of no segment", async () => {
    expect(await resolvePath(0, [], ROOT, env)).toEqual({ ids: [ROOT], finalId: ROOT, item: null });
  });

  it("looks inside the folder the previous segment names", async () => {
    fake.put(folder("sub", "sub", ROOT), file("a", "a.txt", "sub"), file("b", "a.txt", ROOT));
    await crawlAll();

    expect(await resolve("sub", "a.txt")).toBe("a");
    expect(await resolve("a.txt")).toBe("b");
  });

  it("finds nothing under a segment that names no folder", async () => {
    fake.put(file("a", "a.txt", ROOT));
    await crawlAll();

    expect(await resolve("a.txt", "b.txt")).toBeNull();
  });

  it("resolves every URL name a listing shows to the file it was shown for", async () => {
    const files: FakeFile[] = [
      folder("D1", "Docs", ROOT),
      folder("D2", "Docs", ROOT),
      file("A", "x", ROOT),
      file("B", "x", ROOT),
      file("C", "x (dupID: B)", ROOT),
      file("T", "it's (a)\\b", ROOT),
    ];
    fake.put(...files);
    await crawlAll();

    for (const { id, urlName } of await listFolder(0, ROOT, env)) {
      expect(await resolve(urlName), urlName).toBe(id);
    }
  });
});
