import { getPlatformProxy } from "wrangler";

import { applyMigrations } from "./migrations";

type Bindings = { DB: D1Database; KV: KVNamespace };

// The state lives on globalThis because the setup file resets the module registry between files.
const shared = globalThis as { __booted?: Promise<Bindings>; __bindings?: Bindings };

function boot() {
  shared.__booted ??= (async () => {
    const proxy = await getPlatformProxy({ configPath: "test/wrangler.jsonc", persist: false });
    const bindings = proxy.env as unknown as Bindings;
    await applyMigrations(bindings.DB);

    // Never disposed: the worker process owns workerd and takes it down when it exits.
    return bindings;
  })();

  return shared.__booted;
}

async function clean({ DB, KV }: Bindings) {
  const { results } = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  await DB.batch(results.map(({ name }) => DB.prepare(`DELETE FROM \`${name}\``)));

  let cursor: string | undefined;
  do {
    const page = await KV.list({ cursor });
    await Promise.all(page.keys.map(({ name }) => KV.delete(name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// Gives the calling file empty D1 tables and an empty KV namespace. The files run in one worker
// and share one proxy.
export async function openPlatform() {
  shared.__bindings = await boot();
  await clean(shared.__bindings);
}

export function bindings(): Bindings {
  if (!shared.__bindings) throw new Error("bindings() is available from beforeAll onwards");

  return shared.__bindings;
}
