#!/usr/bin/env node
/**
 * Complète, dans une base existante, les textes d'une langue ajoutée au
 * portail (§4) — écrit pour l'arrivée du russe, valable pour la suivante.
 *
 * Une langue nouvelle n'a rien à traduire dans ce que le portail fabrique
 * lui-même, mais une base remplie avant elle n'en porte pas trace. Deux
 * familles de données ont une valeur PAR langue et se complètent sans appel
 * de modèle :
 *
 *   — les NOMS DE LOCALITÉS, tenus dans `db/seed/locations.mjs`. Le nom
 *     russe ajouté devient aussi un terme de recherche : la boîte de
 *     recherche cherche dans toutes les valeurs de `name_i18n`. Les alias
 *     que le fichier a gagnés depuis le seed (graphies cyrilliques
 *     comprises) suivent ;
 *   — les DESCRIPTIONS des annonces collectées, engendrées depuis les faits
 *     par `db/lib/describe.mjs` : on les engendre dans la langue manquante.
 *
 * Rien n'est jamais écrasé : une valeur déjà présente — un nom corrigé en
 * base, une description relue — garde le dessus, seules les clés absentes
 * sont ajoutées. Le job est donc rejouable, et ne change plus rien la
 * deuxième fois.
 *
 * Le texte libre écrit par une agence, lui, ne s'engendre pas : il passe par
 * le traducteur (db/lib/translate.mjs), qui couvre désormais toutes les
 * langues pour les annonces à venir. Les annonces déjà traduites sans la
 * nouvelle langue sont seulement COMPTÉES ici — la fiche leur prête l'anglais
 * en attendant — parce que les retraduire coûte des appels d'API et qu'une
 * traduction relue par un humain ne doit pas être remplacée en douce.
 *
 *   node db/jobs/fill-locales.mjs --dry-run   # ce qui serait complété
 *   node db/jobs/fill-locales.mjs
 */
import pg from "pg";
import { locations } from "../seed/locations.mjs";
import { describe } from "../lib/describe.mjs";
import { LOCALES } from "../lib/messages.mjs";

const dryRun = process.argv.includes("--dry-run");

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const log = (...a) => console.log(...a);

try {
  await db.query("BEGIN");

  // ------------------------------------------------------------ localités
  // `$2 || name_i18n` : à clé égale, l'opérande de droite l'emporte — la
  // valeur en base reste, seules les langues absentes sont prises au fichier.
  let names = 0, aliases = 0, unknown = 0;
  for (const [slug, , , i18n, al] of locations) {
    const { rows: [row] } = await db.query(
      `WITH cur AS (SELECT id, name_i18n, aliases FROM locations WHERE slug = $1)
       UPDATE locations l
          SET name_i18n = $2::jsonb || cur.name_i18n,
              aliases = cur.aliases
                || ARRAY(SELECT a FROM unnest($3::text[]) WITH ORDINALITY u(a, i)
                          WHERE a <> ALL(cur.aliases) GROUP BY a ORDER BY min(i))
         FROM cur
        WHERE l.id = cur.id
          AND (NOT cur.name_i18n ?& ARRAY(SELECT jsonb_object_keys($2::jsonb))
               OR NOT cur.aliases @> $3::text[])
       RETURNING (cur.name_i18n <> l.name_i18n) AS "namesChanged",
                 cardinality(l.aliases) - cardinality(cur.aliases) AS "aliasesAdded"`,
      [slug, JSON.stringify(i18n), al]);
    if (row) {
      if (row.namesChanged) names++;
      aliases += row.aliasesAdded;
    } else {
      const { rowCount } = await db.query(`SELECT 1 FROM locations WHERE slug = $1`, [slug]);
      if (!rowCount) unknown++;
    }
  }
  log(`Localités : ${names} nom(s) complété(s), ${aliases} alias ajouté(s)`
    + (unknown ? ` — ${unknown} absente(s) de la base, ignorée(s)` : ""));

  // ------------------------------------- descriptions engendrées (collecte)
  // Mêmes faits que la passe des pages d'annonce de `import-portal.mjs`, qui
  // régénère la description quand elle apprend l'ameublement : la langue
  // ajoutée dit la même chose que les autres.
  const { rows: generated } = await db.query(
    `SELECT l.id, l.transaction_type::text AS txn, loc.name_i18n AS "hoodNames",
            p.property_type::text AS "propertyType", p.bedrooms, p.floor, p.furnished,
            p.indoor_area_sqm AS indoor, p.land_area_sqm AS land
       FROM listings l
       JOIN properties p ON p.id = l.property_id
       JOIN locations loc ON loc.id = p.location_id
      WHERE l.source = 'portal' AND NOT l.description_i18n ?& $1::text[]`,
    [LOCALES]);
  for (const l of generated) {
    const text = describe({
      property_type: l.propertyType, bedrooms: l.bedrooms,
      indoor_area_sqm: l.indoor === null ? null : Number(l.indoor),
      land_area_sqm: l.land === null ? null : Number(l.land),
      furnished: l.furnished, floor: l.floor,
    }, l.hoodNames, l.txn);
    await db.query(
      `UPDATE listings SET description_i18n = $2::jsonb || description_i18n WHERE id = $1`,
      [l.id, JSON.stringify(text)]);
  }
  log(`Annonces collectées : ${generated.length} description(s) complétée(s)`);

  // ------------------------------------------- texte libre : compté seulement
  const { rows: freeText } = await db.query(
    `SELECT translation_status::text AS status, count(*)::int AS n
       FROM listings
      WHERE source <> 'portal' AND translation_status IN ('machine', 'human_reviewed')
        AND NOT description_i18n ?& $1::text[]
      GROUP BY 1 ORDER BY 1`,
    [LOCALES]);
  if (freeText.length) {
    log(`Texte libre traduit avant l'ajout d'une langue — l'anglais leur est prêté :`);
    for (const r of freeText) log(`  ${r.status} : ${r.n}`);
  }

  if (dryRun) {
    await db.query("ROLLBACK");
    log("(--dry-run : rien n'a été écrit)");
  } else {
    await db.query("COMMIT");
  }
} catch (err) {
  await db.query("ROLLBACK").catch(() => {});
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.end();
}
