#!/usr/bin/env node
/**
 * Vérifie la sauvegarde de la base.
 *
 * Ce qui compte : un dump n'est conservé qu'une fois relu par pg_restore ;
 * chiffré, il se rouvre à l'identique et ne laisse aucun clair ; la copie
 * hors site part signée vers le bucket dédié ; la rotation ne retire que
 * l'excédent le plus ancien et jamais la sauvegarde du jour ; et chaque
 * défaillance (dump impossible, dump illisible, clé malformée) sort en
 * code 1 sans laisser de fichier trompeur.
 *
 * Le dump est réel (la base de développement, dans un répertoire
 * temporaire) ; le hors site est un serveur HTTP local qui joue le rôle du
 * bucket. pg_dump/pg_restore viennent du PATH ou du conteneur de dev.
 *
 *   node db/checks/backup.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decryptArchive, parseArchiveKey } from "../lib/archive-vault.mjs";

const exec = promisify(execFile);
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

// pg_dump du PATH, sinon celui du conteneur de développement.
const hasLocal = await exec("pg_dump", ["--version"]).then(() => true, () => false);
const tools = hasLocal ? {} : {
  BACKUP_PG_DUMP: "docker exec -i cambodia-immo-db pg_dump",
  BACKUP_PG_RESTORE: "docker exec -i cambodia-immo-db pg_restore",
  BACKUP_DATABASE_URL: "postgres://immo:immo@localhost:5432/cambodia_immo",
};
console.log(`Outils : ${hasLocal ? "pg_dump local" : "pg_dump du conteneur de dev"}`);

// Faux bucket : enregistre chaque PUT (chemin, en-têtes, corps).
const puts = [];
const bucket = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    puts.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200); res.end();
  });
});
await new Promise((r) => bucket.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${bucket.address().port}`;

const keyHex = randomBytes(32).toString("hex");
const key = parseArchiveKey({ ARCHIVE_KEY: keyHex });
const dir = await mkdtemp(join(tmpdir(), "chk-backup-"));
const job = (extra, env) => exec("node", ["db/jobs/backup-db.mjs", "--json", "--out", dir, ...extra],
  { env: { ...process.env, ...tools, ...env }, maxBuffer: 64 * 1024 * 1024 })
  .then(({ stdout }) => ({ code: 0, ...JSON.parse(stdout.trim().split("\n").pop()) }),
        (err) => { try { return { code: err.code, ...JSON.parse(err.stdout.trim().split("\n").pop()) }; }
                   catch { return { code: err.code, stderr: err.stderr }; } });

try {
  console.log("Simulation");
  const dry = await job(["--dry-run"], { ARCHIVE_KEY: keyHex });
  check("--dry-run répond sans rien écrire", dry.code === 0 && dry.dryRun && dry.file.endsWith(".dump.enc")
        && (await readdir(dir)).length === 0, JSON.stringify(dry).slice(0, 200));

  console.log("Sauvegarde chiffrée et copiée hors site");
  // Trois « anciennes » sauvegardes pour la rotation (keep=2 : il en reste une, plus celle du jour).
  for (const d of ["2000-01-01T00-00-00", "2000-01-02T00-00-00", "2000-01-03T00-00-00"]) {
    await writeFile(join(dir, `db-${d}.dump.enc`), "ancienne");
  }
  const run = await job(["--keep", "2"], {
    ARCHIVE_KEY: keyHex, ARCHIVE_S3_BUCKET: "sauvegardes-chk", S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY_ID: "AKIACHK", S3_SECRET_ACCESS_KEY: "secret-chk", ARCHIVE_S3_REGION: "ap-southeast-1",
  });
  check("la sauvegarde aboutit, chiffrée, avec des tables", run.code === 0 && run.encrypted
        && run.tables >= 20 && run.file.endsWith(".dump.enc"), JSON.stringify(run).slice(0, 300));
  const files = await readdir(dir);
  check("aucun clair sur le disque", files.every((f) => f.endsWith(".dump.enc")), files.join(", "));
  check("la rotation retire l'excédent le plus ancien et garde la sauvegarde du jour",
        run.pruned.join() === "db-2000-01-01T00-00-00.dump.enc,db-2000-01-02T00-00-00.dump.enc"
          && files.length === 2 && files.includes("db-2000-01-03T00-00-00.dump.enc"),
        `${run.pruned} / ${files}`);

  const clear = decryptArchive(await readFile(run.file), key);
  check("rouverte, c'est un dump PostgreSQL à l'empreinte consignée",
        clear.subarray(0, 5).toString("latin1") === "PGDMP"
          && createHash("sha256").update(clear).digest("hex") === run.sha256 && clear.length === run.bytes);
  // execFile ne prend pas de stdin : passer par vault-open | pg_restore via le shell.
  const listed = await exec("bash", ["-c",
    `node db/jobs/vault-open.mjs "${run.file}" | ${tools.BACKUP_PG_RESTORE ?? "pg_restore"} --list | grep -c "TABLE DATA"`],
    { env: { ...process.env, ARCHIVE_KEY: keyHex } }).then(({ stdout }) => Number(stdout.trim()), () => -1);
  check("vault-open | pg_restore --list retrouve toutes les tables",
        listed === run.tables, `${listed} listées, ${run.tables} annoncées`);
  const wrongKey = await exec("node", ["db/jobs/vault-open.mjs", run.file],
    { env: { ...process.env, ARCHIVE_KEY: randomBytes(32).toString("hex") } }).then(() => 0, (e) => e.code);
  check("une autre clé n'ouvre pas la sauvegarde", wrongKey === 1);

  check("la copie hors site est un PUT signé vers le bucket dédié",
        puts.length === 1 && puts[0].method === "PUT"
          && puts[0].url === `/sauvegardes-chk/backups/${run.file.split("/").pop()}`
          && /^AWS4-HMAC-SHA256 Credential=AKIACHK\/.*\/ap-southeast-1\/s3\/aws4_request/.test(puts[0].headers.authorization ?? ""),
        JSON.stringify({ n: puts.length, url: puts[0]?.url }));
  check("le corps hors site est le fichier scellé, octet pour octet",
        puts[0] && puts[0].body.equals(await readFile(run.file))
          && puts[0].headers["x-amz-content-sha256"] === createHash("sha256").update(puts[0].body).digest("hex"));
  check("le résumé identifie la copie en s3://", run.offsite === `s3://sauvegardes-chk/backups/${run.file.split("/").pop()}`);

  console.log("Défaillances");
  const before = (await readdir(dir)).length;
  const noDump = await job([], { ARCHIVE_KEY: keyHex, BACKUP_PG_DUMP: "/bin/false" });
  check("pg_dump en échec → code 1, dump_failed", noDump.code === 1 && noDump.error === "dump_failed");
  const unreadable = await job([], { ARCHIVE_KEY: keyHex, BACKUP_PG_RESTORE: "/bin/false" });
  check("dump que pg_restore ne lit pas → code 1, rien de conservé",
        unreadable.code === 1 && unreadable.error === "dump_unreadable" && (await readdir(dir)).length === before);
  const badKey = await job([], { ARCHIVE_KEY: "courte" });
  check("clé malformée → refus avant tout dump", badKey.code === 1 && (await readdir(dir)).length === before);
  const noBucketCreds = await job([], { ARCHIVE_KEY: keyHex, ARCHIVE_S3_BUCKET: "x", S3_ENDPOINT: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" });
  check("bucket sans accès → refus avant tout dump", noBucketCreds.code === 1 && (await readdir(dir)).length === before);
} finally {
  await rm(dir, { recursive: true, force: true });
  bucket.close();
}

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
