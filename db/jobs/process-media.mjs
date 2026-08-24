#!/usr/bin/env node
/**
 * Traitement des médias en attente : variantes WebP/AVIF/JPEG générées et
 * stockées, empreinte perceptuelle calculée si absente (§6.2, §7).
 *
 *   node db/jobs/process-media.mjs [--dry-run] [--limit N] [--property UUID] [--json]
 *
 * Chaque média n'est traité qu'une fois (`processed_at`) : un échec est
 * consigné dans `process_error` et ne bloque pas les suivants — remettre
 * `processed_at` à NULL pour retenter. Les URL relatives (photos du seed,
 * médias déjà locaux) sont résolues contre NEXT_PUBLIC_SITE_URL.
 */
import pg from "pg";
import { createMediaStore } from "../lib/media-store.mjs";
import { buildVariants } from "../lib/media-variants.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DRY = has("dry-run");
const LIMIT = Number(opt("limit", "200"));
// Restreint la file à un bien : retraiter les photos d'une fiche précise
// sans attendre le tour du reste.
const PROPERTY = opt("property", null);
const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const { rows: pending } = await db.query(
  `SELECT id, url, phash IS NULL AS "needsPhash"
   FROM media WHERE processed_at IS NULL
     AND ($2::uuid IS NULL OR property_id = $2::uuid)
   ORDER BY created_at LIMIT $1`, [LIMIT, PROPERTY]);
const { rows: [{ count: backlog }] } = await db.query(
  `SELECT count(*) AS count FROM media WHERE processed_at IS NULL`);

if (DRY) {
  const summary = { pending: pending.length, backlog: Number(backlog), processed: 0, failed: 0 };
  console.log(has("json") ? JSON.stringify(summary)
    : `${summary.pending} média(s) seraient traités (${summary.backlog} en file).`);
  await db.end();
  process.exit(0);
}

const store = createMediaStore();
let processed = 0, failed = 0;

for (const media of pending) {
  try {
    const source = media.url.startsWith("/") ? `${SITE}${media.url}` : media.url;
    const res = await fetch(source);
    if (!res.ok) throw new Error(`source ${res.status}`);
    const input = Buffer.from(await res.arrayBuffer());

    const built = await buildVariants(input);
    const variants = [];
    for (const file of built.files) {
      const key = `p/${media.id}/${file.width}.${file.format === "jpeg" ? "jpg" : file.format}`;
      const url = await store.put(key, file.body, file.contentType);
      variants.push({ url, format: file.format, width: file.width,
                      height: file.height, bytes: file.body.length });
    }

    await db.query(
      `UPDATE media SET variants = $2::jsonb,
              width = COALESCE(width, $3), height = COALESCE(height, $4),
              phash = COALESCE(phash, $5::bit(64)),
              processed_at = now(), process_error = NULL
       WHERE id = $1`,
      [media.id, JSON.stringify(variants), built.width, built.height,
       media.needsPhash ? built.phash : null]);
    processed++;
  } catch (err) {
    // L'échec est consigné et le média sort de la file : une image morte ne
    // doit pas être retéléchargée à chaque passage.
    await db.query(
      `UPDATE media SET processed_at = now(), process_error = $2 WHERE id = $1`,
      [media.id, String(err?.message ?? err).slice(0, 300)]);
    failed++;
  }
}

const summary = { pending: pending.length, backlog: Number(backlog), processed, failed };
console.log(has("json") ? JSON.stringify(summary)
  : `${processed} traité(s), ${failed} échec(s), ${summary.backlog - processed - failed} restant(s).`);
await db.end();
process.exit(0);
