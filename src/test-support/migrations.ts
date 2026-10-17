/// <reference types="vite/client" />

const migrations = import.meta.glob<string>("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export async function applyMigrations(db: D1Database) {
  for (const path of Object.keys(migrations).sort()) {
    for (const statement of migrations[path].split("--> statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement.trim()).run();
    }
  }
}
