import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo";
const reset = process.argv.includes("--reset");

const client = new pg.Client({ connectionString: url });
await client.connect();

if (reset) {
  console.log("Réinitialisation du schéma public…");
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const { rows } = await client.query("SELECT name FROM schema_migrations");
const applied = new Set(rows.map((r) => r.name));

const dir = join(here, "migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) {
    console.log(`  = ${file} (déjà appliquée)`);
    continue;
  }
  const sql = await readFile(join(dir, file), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`  + ${file}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`  ! ${file} a échoué :`, err.message);
    process.exit(1);
  }
}

await client.end();
console.log("Migrations à jour.");
