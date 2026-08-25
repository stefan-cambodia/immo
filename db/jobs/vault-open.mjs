#!/usr/bin/env node
/**
 * Ouvre un fichier scellé par le coffre (archive d'audit ou sauvegarde de
 * la base) avec ARCHIVE_KEY : c'est l'outil du jour de l'incident.
 *
 *   node db/jobs/vault-open.mjs <fichier.enc> [--out <fichier>]
 *
 * Sans --out, le clair va sur la sortie standard — d'où :
 *   node db/jobs/vault-open.mjs var/backups/db-….dump.enc \
 *     | pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL"
 */
import { readFile, writeFile } from "node:fs/promises";
import { decryptArchive, parseArchiveKey } from "../lib/archive-vault.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;

if (!file) {
  console.error("Usage : node db/jobs/vault-open.mjs <fichier.enc> [--out <fichier>]");
  process.exit(2);
}
const key = parseArchiveKey();
if (!key) {
  console.error("ARCHIVE_KEY absente : impossible d'ouvrir quoi que ce soit.");
  process.exit(1);
}
let clear;
try {
  clear = decryptArchive(await readFile(file), key);
} catch (err) {
  console.error(`✗ Ouverture impossible : ${err.message}`);
  console.error("  Clé fausse ou fichier altéré — l'étiquette GCM ne pardonne ni l'un ni l'autre.");
  process.exit(1);
}
if (out) {
  await writeFile(out, clear, { flag: "wx" });
  console.error(`✓ ${out} (${clear.length} octets)`);
} else {
  // Un lecteur qui referme tôt (`pg_restore --list` n'a besoin que de la
  // table des matières) n'est pas une erreur.
  process.stdout.on("error", (err) => { if (err.code === "EPIPE") process.exit(0); throw err; });
  process.stdout.write(clear);
}
