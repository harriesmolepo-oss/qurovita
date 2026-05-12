import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    console.log(`→ ${f}`);
    await pool.query(sql);
  }
  console.log("Migrations complete.");
  await pool.end();
}

run().catch(e => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
