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
  const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    logger.info(`→ ${f}`);
    await pool.query(sql);
  }
  logger.info("Migrations complete.");
  await pool.end();
}

run().catch(e => {
  logger.error({ err: e }, "Migration failed");
  process.exit(1);
});
