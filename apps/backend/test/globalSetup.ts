// Runs once before all test files — applies migrations to the test DB.
import { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = "postgresql://qurovita:qurovita_test@localhost:5434/qurovita_test";

export async function setup() {
  const pool = new Pool({ connectionString: TEST_DB });

  await pool.query(`
    create table if not exists _migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = await pool.query<{ filename: string }>(
    "select filename from _migrations",
  );
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const migrationsDir = join(__dirname, "..", "migrations");
  const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

  for (const f of files) {
    if (appliedSet.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    await pool.query(sql);
    await pool.query("insert into _migrations (filename) values ($1)", [f]);
  }

  await pool.end();
}

export async function teardown() {
  // Nothing to do — the test DB container is ephemeral
}
