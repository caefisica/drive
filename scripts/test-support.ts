import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The namespace id a dev server reads from the lockfile, found here without the script's code.
const lock = JSON.parse(readFileSync("void.lock.json", "utf8")) as {
  resolved: { kv_namespaces: Array<{ binding: string; id: string }> };
};

export const DEV_KV_ID = lock.resolved.kv_namespaces.find((kv) => kv.binding === "KV")!.id;

export function readLocalKv(persistDir: string, namespaceId: string, key: string): string | null {
  const wrangler = spawnSync(
    "node_modules/.bin/wrangler",
    ["kv", "key", "get", key, "--namespace-id", namespaceId, "--local", "--persist-to", persistDir],
    { encoding: "utf8" },
  );

  const value = wrangler.stdout.trim();

  return wrangler.status === 0 && value !== "Value not found" ? value : null;
}

export function readDevKv(persistDir: string, key: string): string | null {
  return readLocalKv(persistDir, DEV_KV_ID, key);
}
