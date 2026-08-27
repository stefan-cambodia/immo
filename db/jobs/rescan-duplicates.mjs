#!/usr/bin/env node
/**
 * Réévalue la file de déduplication une fois les photos hachées (§6.2).
 *
 * Le problème que ce job corrige tient en une phrase : **la déduplication
 * décidait avant que la preuve n'existe.**
 *
 * `ingest()` passe à `findDuplicates` les empreintes de `input.photos`. Les
 * canaux qui n'apportent qu'une URL — la collecte de portail, l'import de flux
 * — n'en ont aucune à ce moment-là : les images ne sont téléchargées et
 * hachées que plus tard, par `process-media`. Le seul signal que le brief
 * qualifie de vraie corroboration était donc absent au moment de la décision,
 * et il ne restait que l'étage et le nombre de chambres — qui, sur un marché
 * de typologies répétées, décrivent un quartier et non un bien.
 *
 * Mesuré sur 301 paires mises en file par l'entonnoir, une fois les vraies
 * empreintes calculées :
 *
 *   - 14 paires seulement partageaient une photographie ;
 *   - 286 (95 %) avaient des photos sans aucun rapport ;
 *   - et 101 paires réellement photo-identiques n'étaient PAS en file.
 *
 * Une file à la fois bruyante et aveugle ne se travaille pas. Ce job fait donc
 * deux passes, avec les mêmes règles que l'entonnoir (`scoreMatch`) — la règle
 * ne doit pas exister en deux exemplaires :
 *
 *   1. ÉLAGAGE — chaque paire non tranchée est renotée avec les empreintes
 *      désormais disponibles. Celle qui n'atteint plus le seuil, ou qui reste
 *      sans corroboration alors que les photos ont pu être regardées, sort de
 *      la file. Rien qui ait déjà été tranché par un humain n'est touché.
 *   2. RATTRAPAGE — chaque bien dont les médias portent une empreinte est
 *      repassé par `findDuplicates`, qui voit cette fois les photos. Par
 *      lots, en rotation : les biens jamais réévalués d'abord, puis les
 *      passages les plus anciens (`properties.dedup_rescanned_at`), pour
 *      qu'un plafond de lot ne devienne pas un angle mort sur les derniers
 *      arrivés.
 *
 * Le job ne fusionne jamais : c'est la règle qui prime sur tout le reste
 * (§6.2). Une correspondance forte est déposée en file comme une autre.
 *
 *   node db/jobs/rescan-duplicates.mjs [--dry-run] [--json] [--limit 5000]
 */
import pg from "pg";
import { findDuplicates, queueForReview, scoreMatch, QUEUE_THRESHOLD } from "../lib/dedup.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const limit = Number(opt("limit", "5000"));
const dryRun = flag("dry-run");
const asJson = flag("json");

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const summary = { dryRun, pairsReviewed: 0, pairsDropped: 0, scanned: 0, queued: 0, merged: 0 };

/** Un bien, sous la forme que `scoreMatch` attend d'un candidat. */
const PROPERTY_COLUMNS = `
  p.id, p.reference, p.building_id, p.location_id, p.property_type::text,
  p.floor, p.bedrooms, p.indoor_area_sqm, p.land_area_sqm,
  ARRAY(SELECT DISTINCT l.agency_id::text FROM listings l
         WHERE l.property_id = p.id AND l.status = 'active') AS agency_ids`;

/** Le même bien, sous la forme que `scoreMatch` attend d'une soumission. */
const asInput = (row, phashes) => ({
  buildingId: row.building_id,
  locationId: row.location_id,
  propertyType: row.property_type,
  floor: row.floor,
  bedrooms: row.bedrooms,
  indoorAreaSqm: row.indoor_area_sqm === null ? null : Number(row.indoor_area_sqm),
  landAreaSqm: row.land_area_sqm === null ? null : Number(row.land_area_sqm),
  phashes,
  agencyId: row.agency_ids[0] ?? null,
  // Sans cela le bien se trouve lui-même en tête et masque son doublon.
  excludeId: row.id,
});

await db.query("BEGIN");

// ------------------------------------------------------------------ Élagage
const { rows: pairs } = await db.query(`
  SELECT d.id,
         (SELECT min(phash_distance(ma.phash, mb.phash))
            FROM media ma, media mb
           WHERE ma.property_id = d.property_a_id AND mb.property_id = d.property_b_id
             AND ma.phash IS NOT NULL AND mb.phash IS NOT NULL) AS photo_distance,
         EXISTS (SELECT 1 FROM media m
                  WHERE m.property_id = d.property_a_id AND m.phash IS NOT NULL) AS a_hashed,
         EXISTS (SELECT 1 FROM media m
                  WHERE m.property_id = d.property_b_id AND m.phash IS NOT NULL) AS b_hashed,
         a.id AS a_id, a.building_id AS a_building, a.location_id AS a_location,
         a.property_type::text AS a_type, a.floor AS a_floor, a.bedrooms AS a_bedrooms,
         a.indoor_area_sqm AS a_indoor, a.land_area_sqm AS a_land,
         b.id AS b_id, b.building_id, b.floor, b.bedrooms,
         b.indoor_area_sqm, b.land_area_sqm,
         ARRAY(SELECT DISTINCT l.agency_id::text FROM listings l
                WHERE l.property_id = b.id AND l.status = 'active') AS agency_ids
  FROM dedup_candidates d
  JOIN properties a ON a.id = d.property_a_id
  JOIN properties b ON b.id = d.property_b_id
  WHERE d.reviewed_at IS NULL`);

for (const p of pairs) {
  summary.pairsReviewed++;
  // Les deux côtés doivent être hachés pour que l'absence de ressemblance ait
  // valeur de contre-indice. Sinon on ne sait rien, et on ne touche à rien.
  // Chaque côté, pas un total : deux photos hachées d'un seul bien ne disent
  // rien de l'autre.
  const bothHashed = p.a_hashed && p.b_hashed;
  const input = {
    buildingId: p.a_building, locationId: p.a_location, propertyType: p.a_type,
    floor: p.a_floor, bedrooms: p.a_bedrooms,
    indoorAreaSqm: p.a_indoor === null ? null : Number(p.a_indoor),
    landAreaSqm: p.a_land === null ? null : Number(p.a_land),
    agencyId: null,
  };
  const row = {
    building_id: p.building_id, floor: p.floor, bedrooms: p.bedrooms,
    indoor_area_sqm: p.indoor_area_sqm, land_area_sqm: p.land_area_sqm,
    agency_ids: p.agency_ids, photo_distance: p.photo_distance,
  };
  const s = scoreMatch(input, row);
  const keep = s.score >= QUEUE_THRESHOLD && (!bothHashed || s.corroborated);
  if (!keep) {
    summary.pairsDropped++;
    if (!dryRun) await db.query(`DELETE FROM dedup_candidates WHERE id = $1`, [p.id]);
  } else if (!dryRun) {
    await db.query(`UPDATE dedup_candidates SET score = $2, reasons = $3 WHERE id = $1`,
                   [p.id, Number(s.score.toFixed(3)), s.reasons]);
  }
}

// --------------------------------------------------------------- Rattrapage
const { rows: properties } = await db.query(`
  SELECT ${PROPERTY_COLUMNS},
         ARRAY(SELECT m.phash::text FROM media m
                WHERE m.property_id = p.id AND m.phash IS NOT NULL) AS phashes
  FROM properties p
  WHERE EXISTS (SELECT 1 FROM media m WHERE m.property_id = p.id AND m.phash IS NOT NULL)
  ORDER BY p.dedup_rescanned_at NULLS FIRST, p.created_at
  LIMIT $1`, [limit]);

for (const row of properties) {
  summary.scanned++;
  const verdict = await findDuplicates(db, asInput(row, row.phashes));
  if (verdict.decision === "new" || !verdict.propertyId) continue;
  // Jamais de fusion depuis un job : la décision appartient à un humain.
  if (verdict.decision === "merge") summary.merged++;
  // En simulation, la transaction est annulée mais l'insertion a bien lieu :
  // le compte reste donc celui des paires réellement nouvelles.
  if (await queueForReview(db, row.id, verdict.propertyId, verdict.score, verdict.reasons)) {
    summary.queued++;
  }
}

// Le passage est daté même quand il n'a rien déposé : c'est ce qui fait
// tourner le lot. En simulation, la transaction est annulée avec le reste.
if (properties.length) {
  await db.query(`UPDATE properties SET dedup_rescanned_at = now() WHERE id = ANY($1::uuid[])`,
                 [properties.map((r) => r.id)]);
}

const { rows: [after] } = await db.query(
  `SELECT count(*)::int AS pairs FROM dedup_candidates WHERE reviewed_at IS NULL`);
summary.queueAfter = dryRun ? null : after.pairs;

if (dryRun) await db.query("ROLLBACK"); else await db.query("COMMIT");

if (asJson) console.log(JSON.stringify(summary));
else {
  console.log(`Élagage    : ${summary.pairsDropped} / ${summary.pairsReviewed} paire(s) retirée(s)`);
  console.log(`Rattrapage : ${summary.scanned} bien(s) repassés, ${summary.queued} paire(s) déposée(s)`
            + (summary.merged ? ` (dont ${summary.merged} correspondance(s) forte(s), non fusionnées)` : ""));
  if (!dryRun) console.log(`File       : ${summary.queueAfter} paire(s) en attente`);
  else console.log("(simulation : rien n'a été écrit)");
}

await db.end();
