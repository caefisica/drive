import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudEnv } from "void";

import { getDrive, isDriveIdx, parseDriveIdx } from "../src/config";
import { hashPassword } from "../src/services/crypto";
import { passwordKey } from "../src/services/folder-access";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export type StorePasswordOptions = {
  /** The DRIVES JSON, as in `.env`. */
  drives: string | undefined;
  driveIdx: number;
  password: string;
  /** Defaults to the drive's rootId. */
  folderId?: string;
  /** Write to this production KV namespace instead of the local one. */
  remote?: { namespaceId: string };
  /** Local KV directory, relative to the project root. Defaults to `.void`. */
  persistTo?: string;
};

export type StoredPassword = { key: string; location: string };

export const USAGE =
  "Usage: bun scripts/set-password.ts --drive <index> --password <secret> [--folder-id <id>] [--persist-to <dir> | --remote --namespace-id <id>]";

const VALUE_FLAGS = ["--drive", "--password", "--folder-id", "--namespace-id", "--persist-to"];

// Every argument must be a known flag, with its value. A misspelled flag is not skipped, and a
// flag followed by another flag does not take it as its value, because either one would write the
// password somewhere the operator did not name. The password alone may start with dashes.
function parseFlags(args: string[]): { values: Map<string, string>; remote: boolean } {
  const values = new Map<string, string>();
  let remote = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--remote") {
      remote = true;
      continue;
    }

    if (!VALUE_FLAGS.includes(arg)) {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }

    if (values.has(arg)) {
      throw new Error(`${arg} was given twice\n${USAGE}`);
    }

    const value = args[++i];

    if (value === undefined || (arg !== "--password" && value.startsWith("--"))) {
      throw new Error(`${arg} needs a value\n${USAGE}`);
    }

    values.set(arg, value);
  }

  return { values, remote };
}

/** Reads the `set-password` command line. Throws with the reason when it names no target. */
export function optionsFromArgs(args: string[], drives: string | undefined): StorePasswordOptions {
  const { values, remote } = parseFlags(args);
  const password = values.get("--password");
  const drive = values.get("--drive");
  const namespaceId = values.get("--namespace-id");
  const persistTo = values.get("--persist-to");

  if (password === undefined || password === "") {
    throw new Error(`--password is required\n${USAGE}`);
  }

  if (drive === undefined) {
    throw new Error(`--drive is required\n${USAGE}`);
  }

  const driveIdx = parseDriveIdx(drive);

  if (driveIdx === null) {
    throw new Error(`--drive must be a non-negative integer, got "${drive}"\n${USAGE}`);
  }

  if (!remote && namespaceId !== undefined) {
    throw new Error(`--namespace-id only applies with --remote, which writes the production KV`);
  }

  if (remote && persistTo !== undefined) {
    throw new Error(`--persist-to only applies to the local KV, not with --remote`);
  }

  return {
    drives,
    driveIdx,
    password,
    folderId: values.get("--folder-id"),
    remote: remote ? { namespaceId: namespaceId ?? "" } : undefined,
    persistTo,
  };
}

/** Hashes the password and stores the hash in KV under the folder's `passwd:` key. */
export async function storePassword(options: StorePasswordOptions): Promise<StoredPassword> {
  const { driveIdx, password, remote } = options;

  if (!isDriveIdx(driveIdx)) {
    throw new Error(`drive index must be a non-negative integer, got ${driveIdx}`);
  }

  if (remote && !remote.namespaceId) {
    throw new Error("--remote needs --namespace-id <id>, the id of the production KV namespace");
  }

  const drive = getDrive(driveIdx, { DRIVES: options.drives ?? "[]" } as CloudEnv["Bindings"]);
  if (!drive) {
    throw new Error(`drive ${driveIdx} is not in DRIVES`);
  }

  const key = passwordKey(driveIdx, options.folderId ?? drive.rootId);
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const hash = await hashPassword(password, salt);

  if (remote) {
    putRemote(key, hash, remote.namespaceId);
    return { key, location: `remote namespace ${remote.namespaceId}` };
  }

  putLocal(key, hash, resolve(projectRoot, options.persistTo ?? ".void"));
  return { key, location: "local KV" };
}

/**
 * The id of the KV namespace `vp dev` serves. Void takes it from void.lock.json and names it
 * "local" only when the lockfile does not exist or holds no KV namespace. A lockfile that cannot be
 * read or parsed throws, because writing under the wrong id would store a password nothing reads.
 */
function localKvNamespaceId(): string {
  let text: string;

  try {
    text = readFileSync(join(projectRoot, "void.lock.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "local";
    throw new Error(`could not read void.lock.json: ${(error as Error).message}`);
  }

  let lock: { resolved?: { kv_namespaces?: Array<{ binding: string; id: string }> } };

  try {
    lock = JSON.parse(text);
  } catch (error) {
    throw new Error(`void.lock.json is not valid JSON: ${(error as Error).message}`);
  }

  return lock.resolved?.kv_namespaces?.find((kv) => kv.binding === "KV")?.id ?? "local";
}

// The local KV that `vp dev` serves lives under <persist directory>/v3.
function putLocal(key: string, hash: string, persistDir: string) {
  runWrangler(
    key,
    [
      "kv",
      "key",
      "put",
      key,
      hash,
      "--namespace-id",
      localKvNamespaceId(),
      "--local",
      "--persist-to",
      persistDir,
    ],
    "ignore",
  );
}

function putRemote(key: string, hash: string, namespaceId: string) {
  runWrangler(
    key,
    ["kv", "key", "put", key, hash, "--namespace-id", namespaceId, "--remote"],
    "inherit",
  );
}

function runWrangler(key: string, args: string[], stdout: "inherit" | "ignore") {
  const wrangler = spawnSync(join(projectRoot, "node_modules/.bin/wrangler"), args, {
    cwd: projectRoot,
    stdio: ["ignore", stdout, "inherit"],
  });

  if (wrangler.status !== 0) {
    throw new Error(`wrangler could not store ${key}`);
  }
}
