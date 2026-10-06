/**
 * Set a password for a drive root or specific folder.
 *
 * Usage (local):
 *   bun --env-file=.env.local scripts/set-password.ts --drive 0 --password secret123
 *   bun --env-file=.env.local scripts/set-password.ts --drive 0 --folder-id 1BxiMVs0XRA5nFMdKvBd --password secret123
 *
 * This stores a PBKDF2 hash in KV under `passwd:{driveIdx}:{folderId}`.
 * Without --folder-id the password locks the drive root, whose id is the drive's
 * rootId in DRIVES ("root" for a My Drive root).
 *
 * For remote: use wrangler to write KV directly after computing the hash locally.
 */

import type { CloudEnv } from "void";

import { getDrive } from "../src/config";
import { hashPassword } from "../src/services/crypto";
import { passwordKey } from "../src/services/folder-access";

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const driveIdx = parseInt(getArg("--drive") ?? "0", 10);
const password = getArg("--password");

if (!password) {
  console.error(
    "Usage: bun scripts/set-password.ts --drive <idx> --password <secret> [--folder-id <id>]",
  );
  process.exit(1);
}

const drive = getDrive(driveIdx, { DRIVES: process.env.DRIVES ?? "[]" } as CloudEnv["Bindings"]);
if (!drive) {
  console.error(`drive ${driveIdx} is not in DRIVES`);
  process.exit(1);
}

const folderId = getArg("--folder-id") ?? drive.rootId;

const salt = crypto.getRandomValues(new Uint8Array(16));
const saltStr = btoa(String.fromCharCode(...salt));
const hash = await hashPassword(password, saltStr);

const kvKey = passwordKey(driveIdx, folderId);
console.log(`KV key:  ${kvKey}`);
console.log(`KV hash: ${hash}`);
console.log("");
console.log("Store locally (dev):");
console.log(`  POST http://localhost:5173/__void/kv/set  { key: "${kvKey}", value: "${hash}" }`);
console.log("");
console.log("Store remotely (wrangler):");
console.log(`  echo '${hash}' | wrangler kv key put --binding KV "${kvKey}" --stdin`);
