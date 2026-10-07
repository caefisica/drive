import { describe, expect, it } from "vite-plus/test";

import { parseUrlName, urlName, urlPath, withUrlNames } from "./url-names";

const file = (id: string, name: string) => ({ id, name });

describe("withUrlNames", () => {
  it("leaves a name that no sibling shares as it is", () => {
    expect(withUrlNames([file("a", "x.txt"), file("b", "y.txt")]).map((f) => f.urlName)).toEqual([
      "x.txt",
      "y.txt",
    ]);
  });

  it("gives every file of a shared name its ID, and only those files", () => {
    const named = withUrlNames([file("a", "x.txt"), file("b", "x.txt"), file("c", "y.txt")]);

    expect(named.map((f) => f.urlName)).toEqual(["x.txt (dupID: a)", "x.txt (dupID: b)", "y.txt"]);
  });

  it("keeps the file's own name next to its URL name", () => {
    expect(withUrlNames([file("a", "x"), file("b", "x")])[0]).toEqual({
      id: "a",
      name: "x",
      urlName: "x (dupID: a)",
    });
  });

  it("does not treat names that differ only in case as shared", () => {
    expect(withUrlNames([file("a", "X"), file("b", "x")]).map((f) => f.urlName)).toEqual([
      "X",
      "x",
    ]);
  });
});

describe("urlName", () => {
  it("suffixes a name that already looks like a suffixed one", () => {
    expect(urlName("x (dupID: z)", "q", false)).toBe("x (dupID: z) (dupID: q)");
  });

  it("gives every file of a folder its own URL name, whatever the names are", () => {
    // A file named like another file's suffixed name must not take that file's URL.
    const folder = withUrlNames([
      file("A", "x"),
      file("B", "x"),
      file("C", "x (dupID: B)"),
      file("D", "x (dupID: B) (dupID: C)"),
      file("E", "y"),
    ]);

    const names = folder.map((f) => f.urlName);

    expect(new Set(names).size).toBe(folder.length);
  });
});

describe("parseUrlName", () => {
  it("returns a plain name with no ID", () => {
    expect(parseUrlName("notes.md")).toEqual({ name: "notes.md", id: null });
  });

  it("splits a suffixed name into the file's name and ID", () => {
    expect(parseUrlName("notes.md (dupID: 1AbC_d-e)")).toEqual({
      name: "notes.md",
      id: "1AbC_d-e",
    });
  });

  it("takes the last suffix when the name holds one itself", () => {
    expect(parseUrlName("x (dupID: B) (dupID: C)")).toEqual({ name: "x (dupID: B)", id: "C" });
  });

  it("reads back what urlName wrote, for every file of a folder", () => {
    const folder = withUrlNames([
      file("A", "x"),
      file("B", "x"),
      file("C", "x (dupID: B)"),
      file("D", "multi\nline (dupID: E)"),
    ]);

    for (const f of folder) {
      const { name, id } = parseUrlName(f.urlName);
      const resolved = folder.filter(
        (other) => other.name === name && (id === null || other.id === id),
      );

      expect(resolved).toEqual([f]);
    }
  });
});

describe("urlPath", () => {
  it("ends a folder's path with a slash and a file's without", () => {
    expect(urlPath(2, ["a", "b"], true)).toBe("/2/a/b/");
    expect(urlPath(2, ["a", "b"], false)).toBe("/2/a/b");
  });

  it("is the drive's own path with no names", () => {
    expect(urlPath(2, [], true)).toBe("/2/");
  });

  it("encodes each name, so a slash or a hash stays inside its segment", () => {
    expect(urlPath(0, ["a/b", "c#d", "e f (dupID: x)"], false)).toBe(
      "/0/a%2Fb/c%23d/e%20f%20(dupID%3A%20x)",
    );
  });
});
