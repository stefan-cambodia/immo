#!/usr/bin/env node
/**
 * Rétention du journal d'audit : archiver puis purger.
 *
 * L'ordre n'est pas négociable. Le fichier d'archive est écrit et relu avant
 * qu'une seule ligne ne soit supprimée ; son empreinte SHA-256 est calculée
 * sur le fichier tel qu'il est sur le disque, pas sur ce que le programme
 * croit avoir écrit. La purge est ensuite refusée par la base si cette
 * empreinte manque.
 *
 * Usage :
 *   node db/jobs/audit-retention.mjs [--days N] [--dry-run] [--out DIR] [--json]
 *
 * `--json` n'émet qu'un seul objet JSON en fin d'exécution : c'est ce que
 * consomme le lanceur planifié (`ops/audit-retention.sh`), qui a besoin de
 * savoir quelle archive vérifier plutôt que de deviner en lisant des phrases.
 *
 * Variables d'environnement :
 *   AUDIT_RETENTION_DAYS   défaut 730 (deux ans)
 *   AUDIT_ARCHIVE_DIR      défaut ./var/audit-archive
 *   ARCHIVE_KEY            chiffrement au repos (AES-256-GCM) — la version
 *                          en clair ne survit pas sur le disque
 *   ARCHIVE_S3_BUCKET      copie hors site (cf. db/lib/archive-vault.mjs)
 *   DATABASE_URL
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import pg from "pg";
import { createOffsiteStore, encryptArchive, decryptArchive, parseArchiveKey }
  from "../lib/archive-vault.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const retentionDays = Number(opt("days", process.env.AUDIT_RETENTION_DAYS ?? 730));
const archiveDir = resolve(opt("out", process.env.AUDIT_ARCHIVE_DIR ?? "var/audit-archive"));
const dryRun = flag("dry-run");
const asJson = flag("json");
const actor = process.env.AUDIT_ACTOR ?? `job:${process.env.USER ?? "cron"}`;

// En mode JSON, les messages de progression partent sur stderr : stdout ne
// porte que l'objet final, pour rester analysable sans filtrage.
const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);
const emit = (payload) => {
  if (asJson) process.stdout.write(JSON.stringify(payload) + "\n");
};

if (!Number.isFinite(retentionDays) || retentionDays < 1) {
  console.error("Rétention invalide :", retentionDays);
  process.exit(1);
}

const result = {
  retentionDays, dryRun, actor,
  cutoff: null, candidates: 0, archive: null, sha256: null, purged: 0,
  from: null, to: null, encrypted: false, offsite: null,
};

// La clé et le dépôt hors site sont validés AVANT toute purge : une
// configuration cassée doit arrêter le job tant qu'il est encore inoffensif.
const archiveKey = parseArchiveKey();
const offsite = createOffsiteStore();

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const { rows: [{ cutoff }] } = await db.query(
  `SELECT (now() - ($1 || ' days')::interval) AS cutoff`, [retentionDays]);

// Les entrées `audit_purged` ne sont jamais purgées : c'est leur chaîne qui
// atteste la continuité du journal là où des entrées ont disparu.
const { rows } = await db.query(
  `SELECT id::text, actor_user_id AS "actorUserId", actor_email AS "actorEmail",
          actor_role AS "actorRole", actor_agency AS "actorAgency", action::text,
          target_type::text AS "targetType", target_id AS "targetId",
          target_label AS "targetLabel", details, ip, user_agent AS "userAgent",
          created_at AS "createdAt"
   FROM audit_log
   WHERE created_at < $1 AND action <> 'audit_purged'
   ORDER BY id`,
  [cutoff]);

result.cutoff = new Date(cutoff).toISOString();
result.candidates = rows.length;
log(`Rétention : ${retentionDays} jours (limite ${result.cutoff})`);
log(`Entrées hors rétention : ${rows.length}`);

if (rows.length === 0) {
  log("Rien à archiver.");
  emit(result);
  await db.end();
  process.exit(0);
}

// L'archive est ordonnée par identifiant — c'est stable et cela reflète
// l'ordre d'insertion. La période, elle, se calcule sur les dates : un
// identifiant plus grand ne signifie pas une date plus récente, notamment pour
// des entrées importées ou antidatées.
const times = rows.map((r) => new Date(r.createdAt).getTime());
const span = {
  from: new Date(Math.min(...times)).toISOString(),
  to: new Date(Math.max(...times)).toISOString(),
};
result.from = span.from;
result.to = span.to;
log(`Période : ${span.from} → ${span.to}`);

if (dryRun) {
  const byAction = rows.reduce((acc, r) => ((acc[r.action] = (acc[r.action] ?? 0) + 1), acc), {});
  result.byAction = byAction;
  if (!asJson) console.table(byAction);
  log("--dry-run : aucune écriture, aucune suppression.");
  emit(result);
  await db.end();
  process.exit(0);
}

// ---------------------------------------------------------------- archivage
await mkdir(archiveDir, { recursive: true });
const name = `audit-${span.from.slice(0, 10)}_${span.to.slice(0, 10)}-${rows.length}.jsonl`;
const path = join(archiveDir, name);

const payload = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
await writeFile(path, payload, { encoding: "utf8", flag: "wx" });

// Relecture depuis le disque : l'empreinte doit décrire le fichier réellement
// écrit, pas la chaîne en mémoire.
const onDisk = await readFile(path);
const sha256 = createHash("sha256").update(onDisk).digest("hex");
const lineCount = onDisk.toString("utf8").trimEnd().split("\n").length;

if (lineCount !== rows.length) {
  console.error(`Archive incohérente : ${lineCount} lignes pour ${rows.length} entrées. Purge annulée.`);
  await db.end();
  process.exit(1);
}

result.archive = path;
result.sha256 = sha256;
log(`Archive : ${path}`);
log(`SHA-256 : ${sha256}`);

// ------------------------------------------------------------------- purge
try {
  await db.query("BEGIN");
  const { rows: [{ purge_audit_log: purged }] } = await db.query(
    `SELECT purge_audit_log($1::bigint[], $2::timestamptz, $3, $4, $5, $6)`,
    [rows.map((r) => r.id), cutoff, actor, name, sha256, retentionDays]);
  await db.query("COMMIT");
  result.purged = Number(purged);
  log(`Purgé : ${purged} entrées. La purge est elle-même journalisée.`);
} catch (err) {
  await db.query("ROLLBACK").catch(() => {});
  console.error("Purge refusée :", err.message);
  console.error(`L'archive ${path} est conservée ; aucune entrée n'a été supprimée.`);
  emit({ ...result, error: err.message });
  await db.end();
  process.exit(1);
}

// ------------------------------------------------- chiffrement au repos
// Après la purge : l'empreinte consignée décrit le contenu en clair, le
// chiffrement n'est qu'un habillage sur le disque. La version chiffrée est
// relue et déchiffrée avant que le clair ne soit supprimé — le seul
// exemplaire restant doit avoir prouvé qu'il s'ouvre.
if (archiveKey) {
  const sealedPath = `${path}.enc`;
  await writeFile(sealedPath, encryptArchive(onDisk, archiveKey), { flag: "wx" });
  const reread = decryptArchive(await readFile(sealedPath), archiveKey);
  if (createHash("sha256").update(reread).digest("hex") !== sha256) {
    console.error(`Chiffrement incohérent : ${sealedPath} ne restitue pas l'archive.`);
    console.error(`La version en clair ${path} est conservée.`);
    emit({ ...result, error: "encrypt_mismatch" });
    await db.end();
    process.exit(1);
  }
  await rm(path);
  result.archive = sealedPath;
  result.encrypted = true;
  log(`Chiffrée : ${sealedPath} (le clair est supprimé).`);
}

// ------------------------------------------------------ copie hors site
// Un échec ici n'annule rien — la purge est faite, l'archive locale est
// saine — mais il doit être bruyant : code 1, le lanceur alerte.
if (offsite) {
  try {
    const file = result.archive;
    result.offsite = await offsite.put(
      `audit/${basename(file)}`, await readFile(file), "application/octet-stream");
    log(`Copie hors site : ${result.offsite}`);
  } catch (err) {
    console.error("Copie hors site échouée :", err.message);
    console.error(`L'archive locale ${result.archive} est intacte ; relancer la copie.`);
    emit({ ...result, error: "offsite_failed" });
    await db.end();
    process.exit(1);
  }
}

emit(result);
await db.end();
