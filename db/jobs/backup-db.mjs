#!/usr/bin/env node
/**
 * Sauvegarde de la base : dump, vérification, chiffrement, copie hors site,
 * rotation — dans cet ordre, et chaque étape prouve la précédente.
 *
 * Le dump (`pg_dump --format=custom`) est relu par `pg_restore --list`
 * avant d'être conservé : un fichier que pg_restore ne sait pas lister ne
 * restaurera rien, autant le savoir la nuit même plutôt que le jour de
 * l'incident. Il est ensuite chiffré avec la clé des archives d'audit
 * (ARCHIVE_KEY, AES-256-GCM), relu-déchiffré, et seulement alors le clair
 * est supprimé. La copie hors site emprunte le dépôt des archives
 * (ARCHIVE_S3_BUCKET). La rotation locale ne touche qu'aux sauvegardes
 * plus anciennes que les BACKUP_KEEP dernières, jamais à celle du jour.
 *
 * Usage :
 *   node db/jobs/backup-db.mjs [--dry-run] [--out DIR] [--keep N] [--json]
 *
 * Variables d'environnement :
 *   DATABASE_URL           la base à sauvegarder
 *   BACKUP_DIR             défaut var/backups
 *   BACKUP_KEEP            défaut 14 (sauvegardes locales conservées)
 *   BACKUP_PG_DUMP         commande pg_dump, défaut `pg_dump` — par exemple
 *                          `docker exec -i cambodia-immo-db pg_dump` en dev
 *   BACKUP_PG_RESTORE      commande pg_restore, même logique
 *   BACKUP_DATABASE_URL    URL vue par pg_dump si elle diffère (conteneur)
 *   ARCHIVE_KEY            chiffrement au repos (vivement conseillé)
 *   ARCHIVE_S3_BUCKET      copie hors site (cf. db/lib/archive-vault.mjs)
 *
 * Le dump transite en mémoire (custom format, compressé par pg_dump) : c'est
 * adapté à une base de portail — quelques centaines de Mo au plus — et
 * c'est ce qui permet de vérifier et chiffrer sans fichier intermédiaire.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createOffsiteStore, decryptArchive, encryptArchive, parseArchiveKey }
  from "../lib/archive-vault.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dryRun = flag("dry-run");
const asJson = flag("json");
const outDir = resolve(opt("out", process.env.BACKUP_DIR ?? "var/backups"));
const keep = Number(opt("keep", process.env.BACKUP_KEEP ?? 14));
const dbUrl = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL
  ?? "postgres://immo:immo@localhost:5433/cambodia_immo";
const pgDump = (process.env.BACKUP_PG_DUMP ?? "pg_dump").split(/\s+/);
const pgRestore = (process.env.BACKUP_PG_RESTORE ?? "pg_restore").split(/\s+/);

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);
const emit = (payload) => { if (asJson) process.stdout.write(JSON.stringify(payload) + "\n"); };
const die = (result, error, ...lines) => {
  for (const l of lines) console.error(l);
  emit({ ...result, error });
  process.exit(1);
};

if (!Number.isInteger(keep) || keep < 1) {
  console.error("BACKUP_KEEP invalide :", keep);
  process.exit(1);
}

const result = {
  dryRun, dir: outDir, keep, file: null, sha256: null, bytes: 0, tables: 0,
  encrypted: false, offsite: null, pruned: [],
};

// La clé et le dépôt sont validés AVANT le dump : une configuration cassée
// doit arrêter le job tant qu'il n'a encore rien coûté.
const archiveKey = parseArchiveKey();
const offsite = createOffsiteStore();

/** Lance une commande, capture stdout en Buffer ; stderr est relayé. */
function run(cmd, extra, stdin) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...extra],
                        { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    // Un processus qui se termine avant d'avoir tout lu (pg_restore refusant
    // un flux) ferme le tuyau : l'EPIPE est attendu, le code de sortie parle.
    child.stdin?.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out));
      else reject(new Error(`${cmd[0]} a renvoyé ${code} : ${Buffer.concat(err).toString().trim().slice(0, 400)}`));
    });
    if (stdin) child.stdin.end(stdin);
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const name = `db-${stamp}.dump`;

if (dryRun) {
  // Sans écrire : la commande répond-elle, la base est-elle joignable ?
  try {
    const version = await run(pgDump, ["--version"]);
    log(`pg_dump : ${version.toString().trim()}`);
  } catch (err) {
    die(result, "pg_dump_unavailable", `pg_dump introuvable : ${err.message}`);
  }
  log(`--dry-run : ${name} serait écrit dans ${outDir}` +
      `${archiveKey ? ", chiffré" : ", EN CLAIR (ARCHIVE_KEY absente)"}` +
      `${offsite ? `, copié vers ${offsite.publicUrl}` : ""}.`);
  emit({ ...result, file: join(outDir, name + (archiveKey ? ".enc" : "")) });
  process.exit(0);
}

// -------------------------------------------------------------------- dump
await mkdir(outDir, { recursive: true });
let dump;
try {
  dump = await run(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--dbname", dbUrl]);
} catch (err) {
  die(result, "dump_failed", `Sauvegarde impossible : ${err.message}`);
}
if (dump.length < 64 || dump.subarray(0, 5).toString("latin1") !== "PGDMP") {
  die(result, "dump_invalid", "Le flux produit n'est pas un dump PostgreSQL (en-tête PGDMP absent).");
}

// ------------------------------------------------------------- vérification
// `pg_restore --list` lit la table des matières : un dump tronqué ou
// corrompu échoue ici, avant d'être conservé comme s'il valait quelque chose.
let toc;
try {
  toc = (await run(pgRestore, ["--list"], dump)).toString("utf8");
} catch (err) {
  die(result, "dump_unreadable", `pg_restore ne lit pas le dump : ${err.message}`);
}
result.tables = (toc.match(/^\d+; \d+ \d+ TABLE DATA /gm) ?? []).length;
if (result.tables === 0) {
  die(result, "dump_empty", "Le dump ne contient aucune donnée de table.");
}

const sha256 = createHash("sha256").update(dump).digest("hex");
const clearPath = join(outDir, name);
await writeFile(clearPath, dump, { flag: "wx" });
result.file = clearPath;
result.sha256 = sha256;
result.bytes = dump.length;
log(`Dump : ${clearPath} (${(dump.length / 1048576).toFixed(1)} Mo, ${result.tables} tables, sha256 ${sha256.slice(0, 12)}…)`);

// -------------------------------------------------------------- chiffrement
if (archiveKey) {
  const sealedPath = `${clearPath}.enc`;
  await writeFile(sealedPath, encryptArchive(dump, archiveKey), { flag: "wx" });
  const reread = decryptArchive(await readFile(sealedPath), archiveKey);
  if (createHash("sha256").update(reread).digest("hex") !== sha256) {
    die(result, "encrypt_mismatch",
        `Chiffrement incohérent : ${sealedPath} ne restitue pas le dump. Le clair est conservé.`);
  }
  await rm(clearPath);
  result.file = sealedPath;
  result.encrypted = true;
  log(`Chiffrée : ${sealedPath} (le clair est supprimé).`);
} else {
  log("ARCHIVE_KEY absente : la sauvegarde reste EN CLAIR sur le disque.");
}

// ------------------------------------------------------------ hors site
if (offsite) {
  try {
    result.offsite = await offsite.put(
      `backups/${basename(result.file)}`, await readFile(result.file), "application/octet-stream");
    log(`Copie hors site : ${result.offsite}`);
  } catch (err) {
    die(result, "offsite_failed",
        `Copie hors site échouée : ${err.message}`,
        `La sauvegarde locale ${result.file} est intacte ; relancer la copie.`);
  }
}

// -------------------------------------------------------------- rotation
// Seuls nos propres fichiers (db-*.dump[.enc]), les plus anciens d'abord,
// au-delà des `keep` plus récents. Jamais avant que la nouvelle sauvegarde
// ne soit prouvée : la rotation est la dernière étape.
const entries = (await readdir(outDir)).filter((f) => /^db-.*\.dump(\.enc)?$/.test(f)).sort();
const excess = entries.slice(0, Math.max(0, entries.length - keep));
for (const f of excess) {
  await rm(join(outDir, f));
  result.pruned.push(f);
}
if (excess.length) log(`Rotation : ${excess.length} sauvegarde(s) retirée(s), ${keep} conservée(s).`);

const { size } = await stat(result.file);
log(`Terminé · ${basename(result.file)} · ${(size / 1048576).toFixed(1)} Mo sur le disque.`);
emit(result);
