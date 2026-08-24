#!/usr/bin/env node
/**
 * Vérifie le coffre des archives d'audit (chiffrement au repos, hors site).
 *
 * Ce qui compte : une archive chiffrée se rouvre à l'identique et UNIQUEMENT
 * avec la bonne clé ; un octet altéré la rend illisible en bloc (GCM) ; la
 * rétention chiffrée ne laisse aucun clair sur le disque tout en gardant
 * vérifiable l'empreinte consignée ; et la copie hors site signe des
 * requêtes S3 correctes sans jamais exiger de vraies clés pour le contrôle.
 *
 * Le cycle complet tourne sur de vraies entrées insérées puis purgées : la
 * purge et son entrée `audit_purged` sont réelles (le journal est en ajout
 * seul — c'est le comportement vérifié, pas un dommage).
 *
 *   node db/checks/archive.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { createOffsiteStore, decryptArchive, encryptArchive, parseArchiveKey }
  from "../lib/archive-vault.mjs";

const exec = promisify(execFile);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

// ------------------------------------------------------------ Chiffrement
console.log("Chiffrement");
const keyHex = randomBytes(32).toString("hex");
const key = parseArchiveKey({ ARCHIVE_KEY: keyHex });
check("la clé se valide (64 hexadécimaux)", key?.length === 32);
check("une clé absente désactive sans erreur", parseArchiveKey({}) === null);
let badKey = false;
try { parseArchiveKey({ ARCHIVE_KEY: "court" }); } catch { badKey = true; }
check("une clé malformée est refusée tout de suite", badKey);

const clear = Buffer.from("ligne1\nligne2\nligne3\n");
const sealed = encryptArchive(clear, key);
check("aller-retour à l'identique", decryptArchive(sealed, key).equals(clear));
check("le clair n'apparaît pas dans le scellé", !sealed.includes("ligne1"));
check("deux chiffrements du même clair diffèrent (IV aléatoire)",
      !encryptArchive(clear, key).equals(sealed));

const tampered = Buffer.from(sealed);
tampered[tampered.length - 2] ^= 0xff;
let refusedTamper = false;
try { decryptArchive(tampered, key); } catch { refusedTamper = true; }
check("un octet altéré rend l'archive illisible en bloc", refusedTamper);
let refusedKey = false;
try { decryptArchive(sealed, parseArchiveKey({ ARCHIVE_KEY: randomBytes(32).toString("hex") })); }
catch { refusedKey = true; }
check("une autre clé n'ouvre rien", refusedKey);

// -------------------------------------------------------------- Hors site
console.log("Hors site");
check("aucun bucket configuré : pas de dépôt, pas d'erreur",
      createOffsiteStore({}) === null);
let missingCreds = false;
try { createOffsiteStore({ ARCHIVE_S3_BUCKET: "archives" }); } catch { missingCreds = true; }
check("un bucket sans accès est refusé tout de suite", missingCreds);

// Transport injecté : la signature SigV4 se vérifie sans vraies clés S3.
const seen = [];
const store = createOffsiteStore({
  ARCHIVE_S3_BUCKET: "archives-chk",
  S3_ENDPOINT: "https://s3.example.test",
  S3_ACCESS_KEY_ID: "AKIACHK",
  S3_SECRET_ACCESS_KEY: "secret-chk",
  ARCHIVE_S3_REGION: "ap-southeast-1",
}, { fetchImpl: async (url, init) => (seen.push({ url: String(url), init }),
                                      { ok: true, status: 200 }) });
const putUrl = await store.put("audit/archive.jsonl.enc", sealed, "application/octet-stream");
check("la copie va au bucket dédié, identifiée en s3://",
      putUrl === "s3://archives-chk/audit/archive.jsonl.enc"
        && seen[0].url === "https://s3.example.test/archives-chk/audit/archive.jsonl.enc");
const auth = seen[0].init.headers.authorization ?? "";
check("la requête est signée SigV4 dans la région surchargée",
      auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIACHK/")
        && auth.includes("/ap-southeast-1/s3/aws4_request")
        && /Signature=[0-9a-f]{64}$/.test(auth), auth.slice(0, 80));
check("l'empreinte du contenu accompagne la requête",
      seen[0].init.headers["x-amz-content-sha256"]
        === createHash("sha256").update(sealed).digest("hex"));

// --------------------------------------------------- Rétention chiffrée
console.log("Rétention chiffrée de bout en bout");
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

// Trois entrées anciennes, hors rétention : le journal est en ajout seul,
// leur purge (et l'entrée audit_purged qui l'atteste) est réelle.
const marker = `chk-archive-${Date.now().toString(36)}@example.org`;
for (let i = 0; i < 3; i++) {
  await db.query(
    `INSERT INTO audit_log(actor_email, actor_role, action, target_type, created_at)
     VALUES ($1, 'admin', 'sign_in', 'session', now() - interval '800 days')`, [marker]);
}

const outDir = await mkdtemp(join(tmpdir(), "chk-archive-"));
try {
  const env = { ...process.env, ARCHIVE_KEY: keyHex, AUDIT_ACTOR: "chk:archive" };
  delete env.ARCHIVE_S3_BUCKET; // le hors site est vérifié plus haut, à vide ici
  const { stdout } = await exec("node",
    ["db/jobs/audit-retention.mjs", "--json", "--out", outDir], { env });
  const summary = JSON.parse(stdout.trim().split("\n").pop());
  check("la rétention purge et chiffre",
        summary.purged >= 3 && summary.encrypted === true
          && summary.archive.endsWith(".enc"), stdout.trim().slice(0, 200));

  const files = await readdir(outDir);
  check("aucun clair ne survit sur le disque",
        files.length === 1 && files[0].endsWith(".jsonl.enc"), files.join(", "));

  const reopened = decryptArchive(await readFile(summary.archive), key);
  check("l'empreinte consignée décrit le contenu en clair",
        createHash("sha256").update(reopened).digest("hex") === summary.sha256);
  check("les entrées purgées sont dans l'archive",
        reopened.toString().split(marker).length - 1 === 3);

  const verify = await exec("node", ["db/jobs/audit-verify.mjs", summary.archive], { env })
    .then(() => 0, (e) => e.code);
  check("audit-verify ouvre et confirme l'archive chiffrée", verify === 0);
  const noKey = await exec("node", ["db/jobs/audit-verify.mjs", summary.archive],
    { env: { ...env, ARCHIVE_KEY: "" } }).then(() => 0, (e) => e.code);
  check("sans la clé, la vérification refuse au lieu de deviner", noKey === 1);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
