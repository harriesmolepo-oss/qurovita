import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Ensure the tracking table exists before anything else
  await pool.query(`
    create table if not exists _migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = await pool.query<{ filename: string }>(
    `select filename from _migrations order by filename`,
  );
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

  for (const f of files) {
    if (appliedSet.has(f)) {
      logger.info(`↷ ${f} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    logger.info(`→ ${f}`);
    await pool.query(sql);
    await pool.query(`insert into _migrations (filename) values ($1)`, [f]);
  }

  logger.info("Migrations complete.");
  await pool.end();
}

run().catch(e => {
  logger.error({ err: e }, "Migration failed");
  process.exit(1);
});
