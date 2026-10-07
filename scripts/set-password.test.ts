import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { getPlatformProxy } from "wrangler";

import { verifyPassword } from "../src/services/crypto";

const drives = JSON.stringify([{ name: "my", kind: "my_drive", rootId: "root" }]);

let persistDir: string;

beforeEach(() => {
  persistDir = mkdtempSync(join(tmpdir(), "set-password-"));
});

afterEach(() => {
  rmSync(persistDir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync("bun", ["scripts/set-password.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, DRIVES: drives },
  });
}

describe("set-password CLI", () => {
  it("stores the password and prints where", async () => {
    const result = run("--drive", "0", "--password", "secret", "--persist-to", persistDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("KV key:  passwd:0:root\nStored in local KV.\n");

    const proxy = await getPlatformProxy({
      configPath: "scripts/wrangler.jsonc",
      persist: { path: join(persistDir, "v3") },
    });
    try {
      const hash = await (proxy.env as unknown as { KV: KVNamespace }).KV.get("passwd:0:root");
      expect(await verifyPassword("secret", hash!)).toBe(true);
    } finally {
      await proxy.dispose();
    }
  });

  it("exits 1 with the reason when the drive is not configured", () => {
    const result = run("--drive", "5", "--password", "secret");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drive 5 is not in DRIVES");
  });

  it("exits 1 and writes nothing when --drive is malformed or missing", () => {
    const malformed = run("--drive", "1x", "--password", "secret", "--persist-to", persistDir);
    const missing = run("--password", "secret", "--persist-to", persistDir);

    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("--drive must be a non-negative integer");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--drive is required");
    expect(existsSync(join(persistDir, "v3"))).toBe(false);
  });

  it("exits 1 and writes nothing when a flag is unknown", () => {
    const result = run(
      "--drive",
      "0",
      "--password",
      "s",
      "--folderid",
      "x",
      "--persist-to",
      persistDir,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument --folderid");
    expect(existsSync(join(persistDir, "v3"))).toBe(false);
  });
});
