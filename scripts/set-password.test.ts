import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const drives = JSON.stringify([
  { name: "my", kind: "my_drive", rootId: "root" },
  { name: "shared", kind: "shared_drive", rootId: "0ANVP75EAintnUk9PVA" },
]);

function setPassword(...args: string[]) {
  return spawnSync("bun", ["scripts/set-password.ts", "--password", "secret", ...args], {
    encoding: "utf8",
    env: { ...process.env, DRIVES: drives },
  });
}

describe("set-password", () => {
  it("locks a drive root under the drive's configured root id", () => {
    const result = setPassword("--drive", "1");

    expect(result.stdout).toContain("KV key:  passwd:1:0ANVP75EAintnUk9PVA\n");
  });

  it("uses root for a drive whose root id is root", () => {
    const result = setPassword("--drive", "0");

    expect(result.stdout).toContain("KV key:  passwd:0:root\n");
  });

  it("locks the folder given with --folder-id", () => {
    const result = setPassword("--drive", "1", "--folder-id", "1BxiMVs0XRA5nFMdKvBd");

    expect(result.stdout).toContain("KV key:  passwd:1:1BxiMVs0XRA5nFMdKvBd\n");
  });

  it("refuses a drive that is not configured", () => {
    const result = setPassword("--drive", "5");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drive 5");
  });
});
