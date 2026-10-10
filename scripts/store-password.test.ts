import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { verifyPassword } from "../src/services/crypto";
import { optionsFromArgs, storePassword, type StorePasswordOptions } from "./store-password";
import { DEV_KV_ID, readDevKv, readLocalKv } from "./test-support";

const drives = JSON.stringify([
  { name: "my", kind: "my_drive", rootId: "root" },
  { name: "shared", kind: "shared_drive", rootId: "SHARED_DRIVE_ID" },
]);

let persistDir: string;

beforeEach(() => {
  persistDir = mkdtempSync(join(tmpdir(), "store-password-"));
});

afterEach(() => {
  rmSync(persistDir, { recursive: true, force: true });
});

function store(options: Partial<StorePasswordOptions> = {}) {
  return storePassword({
    drives,
    driveIdx: 0,
    password: "secret",
    persistTo: persistDir,
    ...options,
  });
}

function storedHash(key: string): Promise<string | null> {
  return readDevKv(persistDir, key);
}

// Each write and read starts Wrangler, which takes seconds.
describe("storePassword", { timeout: 30_000 }, () => {
  it("stores a hash of the password under the drive's configured root id", async () => {
    const stored = await store({ driveIdx: 1 });

    expect(stored).toEqual({ key: "passwd:1:SHARED_DRIVE_ID", location: "local KV" });

    const hash = await storedHash("passwd:1:SHARED_DRIVE_ID");
    expect(hash).not.toBeNull();
    expect(await verifyPassword("secret", hash!)).toBe(true);
    expect(await verifyPassword("wrong", hash!)).toBe(false);
  });

  it("writes the KV namespace that void.lock.json names, which is the one vp dev serves", async () => {
    expect(DEV_KV_ID).not.toBe("local");

    const { key } = await store();

    expect(await storedHash(key)).toMatch(/^pbkdf2:/);
    expect(readLocalKv(persistDir, "local", key)).toBeNull();
  });

  it("uses root for a drive whose root id is root", async () => {
    const { key } = await store();

    expect(key).toBe("passwd:0:root");
    expect(await storedHash(key)).toMatch(/^pbkdf2:/);
  });

  it("locks the folder it is given and nothing else", async () => {
    const { key } = await store({ driveIdx: 1, folderId: "1BxiMVs0XRA5nFMdKvBd" });

    expect(key).toBe("passwd:1:1BxiMVs0XRA5nFMdKvBd");
    expect(await storedHash(key)).toMatch(/^pbkdf2:/);
    expect(await storedHash("passwd:1:SHARED_DRIVE_ID")).toBeNull();
  });

  it("replaces the password of a folder that already has one", async () => {
    await store();
    const first = await storedHash("passwd:0:root");

    await store({ password: "another" });

    const second = await storedHash("passwd:0:root");
    expect(second).not.toBe(first);
    expect(await verifyPassword("another", second!)).toBe(true);
  });

  it("refuses a drive that is not configured", async () => {
    await expect(store({ driveIdx: 5 })).rejects.toThrow("drive 5 is not in DRIVES");
    await expect(store({ drives: undefined })).rejects.toThrow("drive 0 is not in DRIVES");
  });

  it("refuses --remote without a namespace id", async () => {
    await expect(store({ remote: { namespaceId: "" } })).rejects.toThrow("--namespace-id");
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses the drive index %s",
    async (driveIdx) => {
      await expect(store({ driveIdx })).rejects.toThrow("non-negative integer");
    },
  );
});

describe("optionsFromArgs", () => {
  const parse = (...args: string[]) => optionsFromArgs(args, drives);

  it("reads the drive, the password and the optional folder", () => {
    expect(parse("--drive", "1", "--password", "secret", "--folder-id", "abc")).toEqual({
      drives,
      driveIdx: 1,
      password: "secret",
      folderId: "abc",
      remote: undefined,
      persistTo: undefined,
    });
  });

  it("reads a remote target", () => {
    expect(
      parse("--drive", "0", "--password", "s", "--remote", "--namespace-id", "ns").remote,
    ).toEqual({ namespaceId: "ns" });
  });

  it("keeps a password that starts with dashes", () => {
    expect(parse("--drive", "0", "--password", "--secret").password).toBe("--secret");
  });

  it.each(["1x", "", "-1", "1.5", "01", "1e3", "99999999999999999999999"])(
    "refuses --drive %j instead of writing to another drive",
    (drive) => {
      expect(() => parse("--drive", drive, "--password", "secret")).toThrow("--drive");
    },
  );

  it("refuses a missing --drive instead of defaulting to drive 0", () => {
    expect(() => parse("--password", "secret")).toThrow("--drive is required");
  });

  it("refuses a --drive with nothing after it", () => {
    expect(() => parse("--password", "secret", "--drive")).toThrow("--drive needs a value");
  });

  it("refuses a flag whose value is the next flag", () => {
    expect(() => parse("--drive", "--password", "secret")).toThrow("--drive needs a value");
    expect(() => parse("--drive", "0", "--password", "s", "--folder-id", "--remote")).toThrow(
      "--folder-id needs a value",
    );
  });

  it.each([
    ["a misspelled flag", ["--folderid", "abc"], "unknown argument --folderid"],
    ["the --flag=value form", ["--drive=1"], "unknown argument --drive=1"],
    ["a stray value", ["extra"], "unknown argument extra"],
    ["a single-dash flag", ["-d", "1"], "unknown argument -d"],
    ["a repeated flag", ["--drive", "1"], "--drive was given twice"],
  ])("refuses %s instead of ignoring it", (_, extra, message) => {
    expect(() => parse("--drive", "0", "--password", "secret", ...extra)).toThrow(message);
  });

  it("refuses a missing password", () => {
    expect(() => parse("--drive", "0")).toThrow("--password is required");
  });

  it("refuses a namespace id without --remote instead of writing the local KV", () => {
    expect(() => parse("--drive", "0", "--password", "s", "--namespace-id", "ns")).toThrow(
      "only applies with --remote",
    );
  });

  it("refuses a local directory with --remote", () => {
    expect(() =>
      parse(
        "--drive",
        "0",
        "--password",
        "s",
        "--remote",
        "--namespace-id",
        "ns",
        "--persist-to",
        "x",
      ),
    ).toThrow("only applies to the local KV");
  });
});
