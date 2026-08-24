#!/usr/bin/env node
/**
 * Vérifie le pipeline des médias (§7).
 *
 * Ce qui compte : les variantes couvrent AVIF + WebP + repli JPEG sans
 * jamais agrandir la source, le stockage local sert les fichiers sur le
 * chemin public `/media/...` (le même que produira le CDN), le job traite
 * chaque média une fois — les échecs consignés sans bloquer la file — et
 * la fiche publique sert un `<picture>` avec les bonnes sources.
 *
 *   node db/checks/media.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import sharp from "sharp";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildVariants, VARIANT_WIDTHS } from "../lib/media-variants.mjs";
import { createMediaStore, LocalStore } from "../lib/media-store.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

// ------------------------------------------------------------- Variantes
console.log("Variantes");
const wide = await sharp({ create: { width: 1600, height: 1000, channels: 3,
  background: { r: 40, g: 90, b: 70 } } }).jpeg().toBuffer();
const built = await buildVariants(wide);
check("dimensions de la source relevées", built.width === 1600 && built.height === 1000);
check("empreinte perceptuelle 64 bits", /^[01]{64}$/.test(built.phash));
const formats = (f) => built.files.filter((x) => x.format === f).map((x) => x.width).sort((a, b) => a - b);
check("AVIF et WebP à chaque largeur",
      formats("avif").join(",") === VARIANT_WIDTHS.join(",")
        && formats("webp").join(",") === VARIANT_WIDTHS.join(","),
      JSON.stringify({ avif: formats("avif"), webp: formats("webp") }));
check("un seul repli JPEG, à la plus grande taille",
      formats("jpeg").join(",") === "1280");
check("le ratio est préservé",
      built.files.every((f) => Math.abs(f.height / f.width - 1000 / 1600) < 0.01));

const narrow = await sharp({ create: { width: 500, height: 400, channels: 3,
  background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
const small = await buildVariants(narrow);
check("jamais d'agrandissement : source de 500 px → variantes 320 seulement",
      small.files.every((f) => f.width <= 500)
        && small.files.filter((f) => f.format === "avif").length === 1,
      JSON.stringify(small.files.map((f) => `${f.format}:${f.width}`)));

// ------------------------------------------------------- Stockage local
console.log("Stockage local");
const store = createMediaStore({});
check("le stockage par défaut est local, servi sous /media",
      store instanceof LocalStore && store.publicUrl === "/media");
const url = await store.put("chk/test.webp", built.files[0].body, "image/webp");
check("l'écriture renvoie l'URL publique", url === "/media/chk/test.webp");
let traversalRefused = false;
try { await store.put("../evasion.webp", Buffer.from("x"), "image/webp"); }
catch { traversalRefused = true; }
check("une clé qui remonte est refusée", traversalRefused);

// --------------------------------------------------------- Job + fiche
console.log("Job et fiche publique");
// Le bien témoin est la PREMIÈRE carte de la recherche par défaut (tri
// « pertinence » : mise en avant, nombre d'agences, fraîcheur) : une fois
// ses médias traités, /en/search doit servir ses variantes. L'URL morte
// ajoutée à côté vérifie que le job consigne un échec sans s'arrêter.
const { rows: [prop] } = await db.query(
  `WITH agg AS (
     SELECT l.property_id, count(DISTINCT l.agency_id)::int AS ac,
            max(l.last_confirmed_at) AS lc, bool_or(l.featured) AS featured
     FROM listings l WHERE l.status = 'active' AND l.transaction_type = 'sale'
     GROUP BY l.property_id)
   SELECT p.id, p.reference FROM properties p
   JOIN agg ON agg.property_id = p.id
   WHERE EXISTS (SELECT 1 FROM media m WHERE m.property_id = p.id)
   ORDER BY agg.featured DESC, agg.ac DESC, agg.lc DESC, p.reference LIMIT 1`);
check("le seed fournit un bien en tête de recherche avec médias",
      Boolean(prop), "lancer npm run db:seed");

const { rows: [dead] } = await db.query(
  `INSERT INTO media(property_id, url, position)
   VALUES ($1, '/api/photo/inexistant/casse', 99) RETURNING id`, [prop.id]);

try {
  const env = { ...process.env, NEXT_PUBLIC_SITE_URL: BASE };
  const { stdout: dry } = await exec("node", ["db/jobs/process-media.mjs", "--dry-run", "--json"],
    { env });
  check("la simulation compte sans rien traiter",
        JSON.parse(dry).pending > 0 && JSON.parse(dry).processed === 0, dry.trim());

  // Traite les seuls médias du bien témoin (photos du seed + URL morte) :
  // le reste de la file appartient au vrai job, pas au contrôle.
  const { stdout } = await exec("node",
    ["db/jobs/process-media.mjs", "--json", "--property", prop.id], { env });
  const summary = JSON.parse(stdout);
  check("le job traite la file et consigne les échecs sans s'arrêter",
        summary.failed >= 1, stdout.trim());

  const { rows: [done] } = await db.query(
    `SELECT variants, phash IS NOT NULL AS "hasPhash", processed_at IS NOT NULL AS closed,
            process_error IS NULL AS clean
     FROM media WHERE property_id = $1 AND position = 0`, [prop.id]);
  check("les variantes sont en base : AVIF, WebP, repli JPEG, poids inclus",
        done.closed && done.clean
          && done.variants.some((v) => v.format === "avif")
          && done.variants.some((v) => v.format === "webp")
          && done.variants.some((v) => v.format === "jpeg")
          && done.variants.every((v) => v.url.startsWith("/media/") && v.bytes > 0),
        JSON.stringify(done.variants ?? []).slice(0, 200));
  check("l'empreinte perceptuelle est posée si absente", done.hasPhash);

  const { rows: [failedRow] } = await db.query(
    `SELECT processed_at IS NOT NULL AS closed, process_error AS error
     FROM media WHERE id = $1`, [dead.id]);
  check("l'URL morte sort de la file avec son erreur consignée",
        failedRow.closed && /404|source/.test(failedRow.error ?? ""),
        JSON.stringify(failedRow));

  const served = await fetch(`${BASE}${done.variants[0].url}`);
  check("la variante est servie sur /media avec un cache immuable",
        served.status === 200
          && served.headers.get("cache-control")?.includes("immutable")
          && served.headers.get("content-type")?.startsWith("image/"),
        String(served.status));
  // Next refuse lui-même le chemin encodé (400) avant notre route ; la garde
  // de la route couvre le chemin décodé (404). Les deux sont des refus.
  const traversal = (await fetch(`${BASE}/media/..%2F..%2Fpackage.json`)).status;
  check("un chemin qui remonte est refusé",
        traversal === 400 || traversal === 404, String(traversal));

  const page = await (await fetch(`${BASE}/en/property/${prop.reference}`)).text();
  check("la fiche sert un <picture> avec source AVIF et repli JPEG",
        page.includes('type="image/avif"') && page.includes(".jpg"), prop.reference);
  const search = await (await fetch(`${BASE}/en/search`)).text();
  check("les cartes de résultats servent aussi les variantes",
        search.includes('type="image/avif"'));
} finally {
  await db.query(`DELETE FROM media WHERE id = $1`, [dead.id]);
  await rm("var/media/chk", { recursive: true, force: true });
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
