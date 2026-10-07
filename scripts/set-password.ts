/**
 * Set a password for a drive root or specific folder.
 *
 * Usage (local, writes the KV that `vp dev` serves):
 *   bun scripts/set-password.ts --drive 0 --password secret123
 *   bun scripts/set-password.ts --drive 0 --folder-id 1BxiMVs0XRA5nFMdKvBd --password secret123
 *
 * Usage (deployed, writes the production KV namespace with `wrangler kv key put`):
 *   bun scripts/set-password.ts --drive 0 --password secret123 --remote --namespace-id <id>
 *
 * This stores a PBKDF2 hash in KV under `passwd:{driveIdx}:{folderId}`. Without
 * --folder-id the password locks the drive root, whose id is the drive's rootId in
 * DRIVES ("root" for a My Drive root). --persist-to sets the local KV directory. It
 * defaults to .void.
 */

import { optionsFromArgs, storePassword } from "./store-password";

try {
  const { key, location } = await storePassword(
    optionsFromArgs(process.argv.slice(2), process.env.DRIVES),
  );

  console.log(`KV key:  ${key}`);
  console.log(`Stored in ${location}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
