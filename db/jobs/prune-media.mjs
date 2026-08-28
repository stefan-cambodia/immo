#!/usr/bin/env node
/**
 * Retire du magasin local les variantes que plus aucune ligne `media` ne
 * référence.
 *
 * Les variantes vivent sous `p/<identifiant du média>/` ; une ligne `media`
 * supprimée sans passer par `removePhoto` — un ancien remplacement de
 * galerie, une purge, un bien retiré en cascade — laisse son dossier derrière
 * elle. Rien ne le sert plus, rien ne le retrouve : c'est du disque perdu, et
 * ça s'accumule à chaque passe.
 *
 * Magasin local seulement : le client S3 du projet ne sait que PUT et DELETE,
 * pas lister — un nettoyage S3 se fait avec l'outil du fournisseur, ou par
 * une règle de cycle de vie sur le bucket.
 *
 *   node db/jobs/prune-media.mjs [--dry-run] [--json]
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { createMediaStore } from "../lib/media-store.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const dryRun = flag("dry-run");
const asJson = flag("json");

const store = createMediaStore();
if (store.provider !== "local") {
  console.error(`magasin ${store.provider} : ce nettoyage ne sait parcourir que le magasin local.`);
  process.exit(2);
}

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();
const { rows } = await db.query(`SELECT id::text FROM media`);
const known = new Set(rows.map((r) => r.id));
await db.end();

const root = join(store.dir, "p");
const dirs = await readdir(root).catch(() => []);
const dirSize = async (dir) => {
  let total = 0;
  for (const f of await readdir(dir).catch(() => [])) {
    total += (await stat(join(dir, f)).catch(() => ({ size: 0 }))).size;
  }
  return total;
};

let orphans = 0, bytes = 0;
for (const id of dirs) {
  if (known.has(id)) continue;
  // Un nom qui n'est pas un identifiant n'est pas à nous : on n'y touche pas.
  if (!/^[0-9a-f-]{36}$/.test(id)) continue;
  orphans++;
  bytes += await dirSize(join(root, id));
  if (!dryRun) await rm(join(root, id), { recursive: true, force: true });
}

const summary = { dryRun, referenced: known.size, directories: dirs.length, orphans, bytes };
if (asJson) console.log(JSON.stringify(summary));
else console.log(`${orphans} dossier(s) orphelin(s) sur ${dirs.length} (${(bytes / 1e6).toFixed(0)} Mo)`
  + (dryRun ? " — simulation, rien n'a été retiré." : " retirés."));
