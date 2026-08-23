#!/usr/bin/env node
/**
 * Vérifie qu'une archive correspond bien à ce que la base dit avoir purgé.
 *
 * C'est la contrepartie de la rétention : sans cette vérification, l'entrée
 * `audit_purged` n'est qu'une affirmation. Avec elle, l'archive et le journal
 * se confirment mutuellement.
 *
 *   node db/jobs/audit-verify.mjs var/audit-archive/audit-....jsonl
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("Usage : node db/jobs/audit-verify.mjs <archive.jsonl>");
  process.exit(1);
}

// Une archive manquante est le cas le plus intéressant : une entrée de purge
// qui ne renvoie à aucun fichier signale soit une archive égarée, soit une
// purge menée sans elle. Cela mérite un message, pas une trace de pile.
let bytes;
try {
  bytes = await readFile(file);
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(`✗ Archive introuvable : ${file}`);
    console.error("  Une purge journalisée sans archive correspondante est une anomalie à instruire.");
    process.exit(1);
  }
  throw err;
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
const lines = bytes.toString("utf8").trimEnd().split("\n");

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const { rows } = await db.query(
  `SELECT details, created_at FROM audit_log
   WHERE action = 'audit_purged' AND details->>'archive' = $1
   ORDER BY id DESC LIMIT 1`,
  [basename(file)]);

if (rows.length === 0) {
  console.error(`✗ Aucune entrée audit_purged ne mentionne ${basename(file)}.`);
  process.exit(1);
}

const claim = rows[0].details;
const checks = [
  ["empreinte SHA-256", claim.sha256 === sha256, `${claim.sha256} attendu, ${sha256} calculé`],
  ["nombre d'entrées", Number(claim.purged) === lines.length, `${claim.purged} annoncées, ${lines.length} présentes`],
];

let ok = true;
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : " — " + detail}`);
  ok &&= pass;
}
console.log(`Purge du ${new Date(rows[0].created_at).toISOString()} · période ${claim.oldest} → ${claim.newest}`);

await db.end();
process.exit(ok ? 0 : 1);
