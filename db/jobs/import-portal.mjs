#!/usr/bin/env node
/**
 * Import des annonces publiées sur un portail immobilier (§6.1, canal 4).
 *
 * Le collecteur (db/lib/portal.mjs) ne rapporte que des faits ; ce job les
 * range, et il le fait par l'entonnoir commun — donc avec la déduplication,
 * la règle du pin manuel et le quota d'abonnement, comme n'importe quel autre
 * canal. Aucune annonce n'entre par une porte dérobée.
 *
 * La DESCRIPTION est fabriquée ici plutôt que reprise : engendrée dans les
 * quatre langues depuis les champs structurés (db/lib/describe.mjs). Le texte
 * de l'annonce d'origine n'est ni lu ni stocké.
 *
 * Les PHOTOS sont celles de l'annonce. `media.url` retient l'adresse de
 * l'image chez la source — c'est la référence, et la trace de provenance —
 * puis `ops/process-media.sh` la télécharge et en produit nos propres
 * variantes AVIF/WebP/JPEG, comme pour une photo venue du bot. Ce détour n'est
 * pas décoratif : le serveur d'images de la source répond 403 à un navigateur
 * qui affiche l'image depuis un autre site, et une fiche qui pointerait
 * directement chez elle n'afficherait que des cadres vides.
 *
 * Les variantes vivent sous `var/media/` (hors dépôt) ou sur le stockage S3 en
 * production : le dépôt ne transporte aucune image.
 *
 * La page de liste ne donne que trois vignettes et aucun fait au-delà des
 * chiffres ; `--photos` ouvre la page de chaque annonce — une requête par
 * bien — pour en tirer la galerie complète ET les faits structurés que la
 * liste n'a pas : régime de propriété, ameublement, équipements. Une annonce
 * sans aucune photo publiée retombe sur le fonds libre de droits maison
 * (public/demo-photos), par une graine dérivée de sa référence.
 *
 * Le lien vers l'annonce d'origine est conservé dans `listings.source_url` :
 * c'est l'attribution, la voie de contact réelle, et ce qui permet de tout
 * retirer d'une seule commande (--purge).
 *
 *   node db/jobs/import-portal.mjs --pages 10 --dry-run
 *   node db/jobs/import-portal.mjs --pages 25 --txn both
 *   node db/jobs/import-portal.mjs --pages 55 --from 26   # la suite, sans relire
 *   node db/jobs/import-portal.mjs --pages 50 --area siem-reap   # liste cadrée sur une ville
 *   node db/jobs/import-portal.mjs --photos          # pages d'annonce : galeries et faits
 *   node db/jobs/import-portal.mjs --photos --limit 3  # un échantillon, pour vérifier
 *   node db/jobs/import-portal.mjs --purge
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { ingest } from "../lib/ingest.mjs";
import { describe } from "../lib/describe.mjs";
import { createMediaStore } from "../lib/media-store.mjs";
import { storageKeys } from "../lib/media-upload.mjs";
import { collect, fetchDetail, SOURCES, DEFAULT_DELAY_MS, MAX_PHOTOS }
  from "../lib/portal.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const portal = opt("portal", "realestate.com.kh");
const pages = Number(opt("pages", "5"));
// Première page lue : une montée en volume reprend après les pages déjà
// importées au lieu de les relire — une référence connue serait de toute
// façon « déjà importée », mais chaque page relue coûte une requête à la source.
const from = Number(opt("from", "1"));
// Ville de la source : la liste nationale est plafonnée à 50 pages, une liste
// par ville a le sien — c'est ainsi qu'on dépasse le millier d'annonces.
const area = opt("area", null);
const txnArg = opt("txn", "both");
const delayMs = Number(opt("delay", String(DEFAULT_DELAY_MS)));
const dryRun = flag("dry-run");
const asJson = flag("json");
const purge = flag("purge");
const photosOnly = flag("photos");
const concurrency = Number(opt("concurrency", "2"));
// Borne de la passe des pages d'annonce ; sans borne, tout ce qui reste à lire.
const limit = Number(opt("limit", "0"));

const source = SOURCES[portal];
if (!source) {
  console.error(`Portail inconnu : ${portal}. Connus : ${Object.keys(SOURCES).join(", ")}`);
  process.exit(2);
}
const transactions = txnArg === "both" ? ["sale", "rent"] : [txnArg];
if (transactions.some((t) => !["sale", "rent"].includes(t))) {
  console.error("--txn attend sale, rent ou both");
  process.exit(2);
}

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

/** Motifs d'écart et d'échec, comptés pour le bilan. */
const reasons = {};
const note = (k) => { reasons[k] = (reasons[k] ?? 0) + 1; };

// ------------------------------------------------------------------- purge
// Tout ce qui vient d'un portail porte sa provenance dans la donnée : on peut
// donc le retirer intégralement, sans toucher au reste de la base.
if (purge) {
  await db.query("BEGIN");
  const { rowCount: nListings } = await db.query(`DELETE FROM listings WHERE source = 'portal'`);
  const { rowCount: nProps } = await db.query(
    `DELETE FROM properties p
      WHERE p.geo_pin_by LIKE 'portal:%'
        AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.property_id = p.id)`);
  const { rowCount: nSubs } = await db.query(`DELETE FROM submissions WHERE source = 'portal'`);
  await db.query("COMMIT");
  log(`Retiré : ${nListings} annonce(s), ${nProps} bien(s), ${nSubs} soumission(s).`);
  if (asJson) console.log(JSON.stringify({ purged: { listings: nListings, properties: nProps, submissions: nSubs } }));
  await db.end();
  process.exit(0);
}

// ------------------------------------------------- galeries complètes
// La page de liste ne porte que quelques vignettes, et aucun des faits qui
// nourrissent les filtres de §5 : régime de propriété (donc éligibilité aux
// étrangers), ameublement, équipements. Les lire demande d'ouvrir la page de
// chaque annonce : c'est une requête par bien, donc une passe séparée,
// reprenable, et lancée à la main.
//
// « Déjà lu » se lit sur la soumission (`payload.detailFetchedAt`), pas sur le
// nombre de médias : la liste en donne déjà trois, et un critère du type
// « moins de deux photos » faisait sauter 874 biens sur 898 — la passe
// tournait à vide en annonçant que tout était fait. Une galerie vide chez la
// source est marquée aussi : on ne la redemande pas à chaque relance. Seul un
// échec (réseau, HTTP) laisse le bien sans marque, pour être repris.
//
// Les faits ne sont écrits que sur les biens CRÉÉS par la collecte
// (`geo_pin_by = 'portal:…'`) : une annonce collectée qui s'est greffée sur un
// bien saisi par une agence n'a pas à en réécrire la fiche. Le régime de
// propriété n'est posé que s'il est encore inconnu, jamais remplacé.
if (photosOnly) {
  // Une galerie remplacée retire ses variantes du magasin : une ligne `media`
  // supprimée ne doit pas laisser ses fichiers derrière elle.
  const store = createMediaStore();
  const { rows: todo } = await db.query(
    `SELECT DISTINCT ON (l.property_id)
            l.property_id AS "propertyId", l.source_url AS "sourceUrl",
            s.id AS "submissionId"
       FROM listings l
       JOIN submissions s ON s.listing_id = l.id
      WHERE l.source = 'portal' AND l.source_url IS NOT NULL
        AND s.payload->>'detailFetchedAt' IS NULL
      ORDER BY l.property_id, l.created_at
      ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ""}`);

  log(`Pages d'annonce à lire : ${todo.length} bien(s) — ${concurrency} en parallèle, `
    + `${delayMs} ms entre deux requêtes par fil`);

  let done = 0, filled = 0, empty = 0, failed = 0, titled = 0, furnishedN = 0, equipped = 0;
  let unchanged = 0;
  const queue = todo.slice();

  // Les fils partagent UNE connexion. Ce qui peut se faire de front, c'est
  // attendre la source ; l'écriture, elle, passe par un tour de rôle : deux
  // transactions ouvertes sur la même connexion s'entrelacent, et le COMMIT
  // ou le ROLLBACK de l'une clôt celle de l'autre — galerie à moitié écrite,
  // puis sautée à la relance parce qu'elle compte déjà deux photos.
  let turn = Promise.resolve();
  const serialized = (work) => {
    const mine = turn.then(work, work);
    turn = mine.catch(() => {});
    return mine;
  };

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const detail = await fetchDetail(item.sourceUrl);
        // `null` : page inaccessible ou illisible — pas de marque, on reprendra.
        if (detail === null) throw new Error("page d'annonce illisible");
        const { photos, facts } = detail;
        await serialized(async () => {
          try {
            await db.query("BEGIN");
            // Une galerie identique n'est pas réécrite : chaque ligne `media`
            // porte son empreinte et ses variantes déjà produites, et les
            // recréer les perdrait — tout serait à retélécharger et à hacher,
            // et les anciennes variantes resteraient orphelines sur le disque.
            const { rows: current } = await db.query(
              `SELECT url FROM media WHERE property_id = $1 ORDER BY position`, [item.propertyId]);
            const same = photos.length > 0 && current.length === photos.length
              && current.every((m, i) => m.url === photos[i].url);
            if (same) unchanged++;
            if (photos.length && !same) {
              const { rows: gone } = await db.query(
                `DELETE FROM media WHERE property_id = $1 RETURNING url, variants`, [item.propertyId]);
              for (const m of gone) {
                for (const key of storageKeys(m, store)) await store.remove(key).catch(() => {});
              }
              for (const [position, photo] of photos.entries()) {
                await db.query(
                  `INSERT INTO media(property_id, url, position, width, height, variants)
                   VALUES ($1,$2,$3,$4,$5,$6)`,
                  [item.propertyId, photo.url, position, photo.width, photo.height,
                   JSON.stringify(photo.variants ?? [])]);
              }
            }
            const { rows: [prop] } = await db.query(
              `UPDATE properties
                  SET title_type = CASE WHEN title_type = 'unknown' AND $2::title_type IS NOT NULL
                                        THEN $2::title_type ELSE title_type END,
                      furnished = $3,
                      amenities = $4::text[],
                      updated_at = now()
                WHERE id = $1 AND geo_pin_by LIKE 'portal:%'
                RETURNING title_type::text AS "titleType", property_type::text AS "propertyType",
                          bedrooms, indoor_area_sqm AS "indoor", land_area_sqm AS "land", floor`,
              [item.propertyId, facts.titleType, facts.furnished, facts.amenities]);
            if (prop) {
              // La description est fabriquée depuis les faits : elle suit.
              const { rows: ls } = await db.query(
                `SELECT l.id, l.transaction_type::text AS txn, loc.name_i18n AS "hoodNames"
                   FROM listings l JOIN properties p ON p.id = l.property_id
                   JOIN locations loc ON loc.id = p.location_id
                  WHERE l.property_id = $1 AND l.source = 'portal'`, [item.propertyId]);
              for (const l of ls) {
                await db.query(`UPDATE listings SET description_i18n = $2 WHERE id = $1`,
                  [l.id, JSON.stringify(describe({
                    property_type: prop.propertyType, bedrooms: prop.bedrooms,
                    indoor_area_sqm: prop.indoor === null ? null : Number(prop.indoor),
                    land_area_sqm: prop.land === null ? null : Number(prop.land),
                    furnished: facts.furnished, floor: prop.floor,
                  }, l.hoodNames, l.txn))]);
              }
            }
            await db.query(
              `UPDATE submissions
                  SET payload = payload || jsonb_build_object('detailFetchedAt', now(),
                                                              'galleryPhotos', $2::int,
                                                              'facts', $3::jsonb)
                WHERE id = $1`, [item.submissionId, photos.length, JSON.stringify(facts)]);
            await db.query("COMMIT");
          } catch (e) {
            await db.query("ROLLBACK").catch(() => {});
            throw e;
          }
        });
        if (photos.length) filled++; else empty++;
        if (facts.titleType) titled++;
        if (facts.furnished) furnishedN++;
        if (facts.amenities.length) equipped++;
      } catch (e) {
        failed++;
        note(String(e.message).slice(0, 80));
      }
      if (++done % 50 === 0) log(`  ${done}/${todo.length}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  log(`Galeries : ${filled} lue(s) dont ${unchanged} inchangée(s), ${empty} sans photo publiée, ${failed} en échec`);
  log(`Faits    : ${titled} régime(s) de propriété, ${furnishedN} meublé(s), ${equipped} avec équipements`);
  if (asJson) console.log(JSON.stringify({ photos: { filled, empty, failed },
                                           facts: { titled, furnished: furnishedN, equipped } }));
  await db.end();
  process.exit(0);
}

// ------------------------------------------------------ agence du portail
// UNE agence par portail, et un interlocuteur générique : les pages sources
// exposent le nom, le téléphone et le courriel d'agents réels, et rien de tout
// cela n'a à entrer dans notre base. Le contact réel reste `source_url`.
//
// Le quota d'abonnement est ouvert : il modélise ce qu'une agence cliente a
// acheté (§8), notion sans objet pour une source collectée. Sans cela
// l'entonnoir retiendrait les annonces au-delà de la vingtième.
const { rows: agencyRows } = await db.query(
  `INSERT INTO agencies(slug, name, verification_status, subscription_tier, listing_quota)
   VALUES ($1, $2, 'unverified', 'free', 1000000)
   ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
                                    listing_quota = EXCLUDED.listing_quota
   RETURNING id`, [source.slug, source.label]);
const agencyId = agencyRows[0].id;

const { rows: agentRows } = await db.query(
  `WITH existing AS (SELECT id FROM agents WHERE agency_id = $1 LIMIT 1),
        created AS (
          INSERT INTO agents(agency_id, name, phone, spoken_langs)
          SELECT $1, $2, '—', '{en,km}'::locale_code[]
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING id)
   SELECT id FROM existing UNION ALL SELECT id FROM created`,
  [agencyId, `${source.label} — annonces collectées`]);
const agentId = agentRows[0].id;

// -------------------------------------------------------------- collecte
const records = [];
for (const transaction of transactions) {
  log(`Collecte ${portal}${area ? ` · ${area}` : ""} · ${transaction} · ${pages} page(s)`);
  records.push(...await collect({ portal, transaction, pages, from, area, delayMs,
                                  onPage: (m) => log(`  ${m}`) }));
}
log(`${records.length} annonce(s) exploitables`);

// ------------------------------------------------------------ résolution
/**
 * Fait atterrir une adresse sur une localité connue.
 *
 * L'adresse va du plus précis au plus large. On n'accepte une correspondance
 * fine que si elle est quasi exacte : « Phsar Kandal I » ressemble assez à
 * « Kandal » pour tromper une similarité lâche, et rangerait une annonce de
 * Daun Penh dans une autre province. Faute de quoi on remonte d'un cran —
 * mieux vaut le bon district que la mauvaise commune.
 */
const EXACT = 0.85, LOOSE = 0.6;
async function resolveLocation(parts) {
  let fallback = null;
  for (const [depth, part] of parts.entries()) {
    const { rows } = await db.query(
      `WITH input AS (SELECT lower(unaccent($1)) AS q)
       SELECT l.id, l.slug, l.name_i18n AS "nameI18n",
              (SELECT max(GREATEST(similarity(lower(unaccent(term)), input.q),
                          CASE WHEN lower(unaccent(term)) = input.q THEN 1.0 ELSE 0 END))
               FROM unnest(l.aliases || ARRAY[l.slug]
                           || ARRAY(SELECT v FROM jsonb_each_text(l.name_i18n) AS e(k,v))) term,
                    input) AS score
       FROM locations l ORDER BY score DESC NULLS LAST LIMIT 1`, [part]);
    if (!rows.length) continue;
    const score = Number(rows[0].score);
    if (score >= EXACT) return { ...rows[0], part, score };
    // Un à-peu-près ne l'emporte que si rien de plus large ne fait mieux : on
    // garde le meilleur candidat des niveaux suivants, pas celui d'ici.
    if (score >= LOOSE && (!fallback || depth > fallback.depth)) {
      fallback = { ...rows[0], part, score, depth };
    }
  }
  return fallback;
}

/** Graine d'image stable : la même annonce montre toujours les mêmes photos. */
const photoSeed = (rec) =>
  createHash("sha1").update(`${rec.portal}:${rec.externalRef}`).digest("hex").slice(0, 8);

/** Repli : le fonds libre de droits maison, quand l'annonce n'a aucune photo. */
function fallbackPhotos(rec) {
  const seed = photoSeed(rec);
  const n = Math.min(Math.max(rec.photoCount || 4, 3), MAX_PHOTOS);
  return Array.from({ length: n }, (_, i) => ({
    url: `/api/photo/${rec.propertyType}-${seed}-${i}`,
    width: 1600, height: 1067, phash: null, variants: [],
  }));
}

// ---------------------------------------------------------------- import
const summary = {
  portal, pages, from, area, transactions, dryRun,
  total: records.length, accepted: 0, created: 0, merged: 0, review: 0,
  needsPin: 0, duplicates: 0, skipped: 0, failed: 0, reasons,
};

for (const rec of records) {
  const loc = await resolveLocation(rec.addressParts);
  if (!loc) { summary.skipped++; note("localité introuvable"); continue; }

  // Photos de l'annonce, par leur adresse chez la source. La page de liste
  // n'en porte qu'une ; `--photos` complétera la galerie. Une annonce sans
  // photo publiée retombe sur le fonds maison, pour ne pas laisser une fiche
  // nue dans les résultats.
  const photos = rec.photos.length
    ? rec.photos.map((p) => ({ ...p, phash: null }))
    : fallbackPhotos(rec);

  const input = {
    source: "portal",
    agencyId, agentId,
    externalRef: rec.externalRef,
    payload: rec,
    normalized: {
      propertyType: rec.propertyType,
      locationId: loc.id,
      buildingId: null,
      floor: rec.floor,
      unitNumber: null,
      bedrooms: rec.bedrooms,
      bathrooms: rec.bathrooms,
      indoorAreaSqm: rec.indoorAreaSqm,
      landAreaSqm: rec.landAreaSqm,
      titleType: "unknown",
      furnished: false,
      transactionType: rec.transaction,
      priceUsd: rec.priceUsd,
      // Pas de texte repris : la description est fabriquée plus bas.
      description: null,
      descriptionLang: "en",
      // Le portail publie des coordonnées posées par l'agent : c'est un pin,
      // pas un géocodage d'adresse (principe n°2).
      lng: rec.lng, lat: rec.lat,
    },
    photos,
  };

  try {
    await db.query("BEGIN");
    const outcome = await ingest(db, input);

    if (outcome.status === "accepted") {
      // La description sort des champs structurés, dans les quatre langues
      // (§4.1). Rien à traduire : ce n'est pas du texte libre, donc
      // `not_needed` plutôt que la file du traducteur — et le marquage
      // « traduction automatique » de la fiche, qui découle de cet état,
      // tombe de lui-même.
      await db.query(
        `UPDATE listings
            SET description_i18n = $2, translation_status = 'not_needed',
                source_url = $3
          WHERE id = $1`,
        [outcome.listingId,
         JSON.stringify(describe({
           property_type: rec.propertyType, bedrooms: rec.bedrooms,
           indoor_area_sqm: rec.indoorAreaSqm, land_area_sqm: rec.landAreaSqm,
           furnished: false, floor: rec.floor,
         }, loc.nameI18n, rec.transaction)),
         rec.sourceUrl]);
    }

    if (dryRun) await db.query("ROLLBACK"); else await db.query("COMMIT");

    if (outcome.status === "accepted") {
      summary.accepted++;
      if (outcome.decision === "merge") summary.merged++;
      else if (outcome.decision === "review") summary.review++;
      else summary.created++;
    } else if (outcome.status === "needs_pin") summary.needsPin++;
    else if (outcome.status === "duplicate_submission") summary.duplicates++;
  } catch (e) {
    await db.query("ROLLBACK");
    summary.failed++;
    note(String(e.message).slice(0, 80));
  }
}

log("");
log(`Bilan — ${summary.accepted} acceptée(s) : ${summary.created} bien(s) créé(s), `
  + `${summary.merged} fusionnée(s), ${summary.review} en file de validation`);
log(`        ${summary.duplicates} déjà importée(s), ${summary.skipped} écartée(s), `
  + `${summary.failed} en échec`);
for (const [reason, n] of Object.entries(summary.reasons)) log(`        · ${reason} : ${n}`);
if (dryRun) log("(simulation : rien n'a été écrit)");
if (asJson) console.log(JSON.stringify(summary));

await db.end();
