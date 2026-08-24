#!/usr/bin/env node
/**
 * Vérifie qu'une archive correspond bien à ce que la base dit avoir purgé.
 *
 * C'est la contrepartie de la rétention : sans cette vérification, l'entrée
 * `audit_purged` n'est qu'une affirmation. Avec elle, l'archive et le journal
 * se confirment mutuellement.
 *
 *   node db/jobs/audit-verify.mjs var/audit-archive/audit-....jsonl[.enc]
 *
 * Une archive chiffrée (suffixe .enc, ARCHIVE_KEY posée) est déchiffrée
 * avant vérification : l'empreinte consignée décrit le contenu en clair.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import pg from "pg";
import { decryptArchive, parseArchiveKey } from "../lib/archive-vault.mjs";

let file = process.argv[2];
if (!file) {
  console.error("Usage : node db/jobs/audit-verify.mjs <archive.jsonl[.enc]>");
  process.exit(1);
}

// Une archive manquante est le cas le plus intéressant : une entrée de purge
// qui ne renvoie à aucun fichier signale soit une archive égarée, soit une
// purge menée sans elle. Cela mérite un message, pas une trace de pile.
let bytes;
try {
  bytes = await readFile(file);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  // La rétention chiffrée ne laisse que le .enc : accepter le nom en clair.
  try {
    bytes = await readFile(`${file}.enc`);
    file = `${file}.enc`;
  } catch {
    console.error(`✗ Archive introuvable : ${file}`);
    console.error("  Une purge journalisée sans archive correspondante est une anomalie à instruire.");
    process.exit(1);
  }
}

if (file.endsWith(".enc")) {
  const key = parseArchiveKey();
  if (!key) {
    console.error("✗ Archive chiffrée mais ARCHIVE_KEY absente : impossible de vérifier.");
    process.exit(1);
  }
  try {
    bytes = decryptArchive(bytes, key);
  } catch (err) {
    console.error(`✗ Déchiffrement impossible : ${err.message}`);
    console.error("  Clé fausse ou archive altérée — l'étiquette GCM ne pardonne ni l'un ni l'autre.");
    process.exit(1);
  }
}

const sha256 = createHash("sha256").update(bytes).digest("hex");
const lines = bytes.toString("utf8").trimEnd().split("\n");

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

// L'entrée de purge consigne le nom EN CLAIR : le suffixe .enc n'est qu'un
// habillage du disque, il ne change pas ce qui a été purgé.
const claimName = basename(file).replace(/\.enc$/, "");
const { rows } = await db.query(
  `SELECT details, created_at FROM audit_log
   WHERE action = 'audit_purged' AND details->>'archive' = $1
   ORDER BY id DESC LIMIT 1`,
  [claimName]);

if (rows.length === 0) {
  console.error(`✗ Aucune entrée audit_purged ne mentionne ${claimName}.`);
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
