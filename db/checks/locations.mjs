#!/usr/bin/env node
/**
 * Vérifie le compteur d'annonces par localité (§5).
 *
 * `locations.listing_count` est dénormalisé et VISIBLE : la page d'accueil
 * range les douze quartiers les plus actifs dessus et écarte ceux à zéro, la
 * boîte de recherche l'affiche au visiteur à côté de chaque suggestion. Un
 * chiffre visible qu'aucune écriture ne tient à jour finit par mentir — il
 * n'était rafraîchi que par un script de seed, et un import de 173 annonces
 * laissait trente localités dérivées, de 110 pour Phnom Penh.
 *
 * Le contrôle porte donc sur l'invariant lui-même, puis sur les deux pièges du
 * calcul : la descente doit être récursive, et une localité vidée doit
 * retomber à zéro.
 *
 *   node db/checks/locations.mjs
 */
import pg from "pg";
import { refreshLocationCounts } from "../lib/locations.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

/** Le compte de référence, calculé sans passer par la fonction éprouvée. */
const REEL = `
  WITH RECURSIVE d AS (
    SELECT id AS racine, id FROM locations
    UNION ALL SELECT d.racine, l.id FROM d JOIN locations l ON l.parent_id = d.id)
  SELECT d.racine AS id, count(DISTINCT p.id)::int AS n
    FROM d JOIN properties p ON p.location_id = d.id
    JOIN listings l ON l.property_id = p.id AND l.status = 'active'
   GROUP BY d.racine`;

const derive = async () => (await db.query(
  `WITH reel AS (${REEL})
   SELECT count(*)::int AS n,
          COALESCE(sum(abs(loc.listing_count - COALESCE(r.n, 0))), 0)::int AS ecart
     FROM locations loc LEFT JOIN reel r ON r.id = loc.id
    WHERE loc.listing_count IS DISTINCT FROM COALESCE(r.n, 0)`)).rows[0];

console.log("Invariant sur la base");
const avant = await derive();
check("aucune localité ne dérive", avant.n === 0,
      `${avant.n} localité(s), ${avant.ecart} d'écart — lancer npm run listings:expire`);

console.log("\nRafraîchissement");
await db.query("BEGIN");
check("sur une base juste, le rafraîchissement ne change rien",
      (await refreshLocationCounts(db)) === 0);

// Une localité vidée doit retomber à zéro. L'ancien calcul ne touchait que les
// lignes que sa sous-requête produisait : une localité sans annonce n'y
// figurait pas, et gardait son dernier chiffre pour toujours.
const { rows: [peuplee] } = await db.query(
  `SELECT id, slug, listing_count AS n FROM locations
    WHERE listing_count > 0 AND level = 'neighborhood' ORDER BY listing_count LIMIT 1`);
check("le jeu fournit un quartier peuplé", Boolean(peuplee), "lancer npm run db:seed-base");
if (peuplee) {
  await db.query(
    `UPDATE listings SET status = 'expired'
      WHERE property_id IN (SELECT id FROM properties WHERE location_id = $1)`, [peuplee.id]);
  const changees = await refreshLocationCounts(db);
  const { rows: [apres] } = await db.query(
    `SELECT listing_count AS n FROM locations WHERE id = $1`, [peuplee.id]);
  check(`un quartier vidé retombe à zéro (${peuplee.slug})`, apres.n === 0,
        `${peuplee.n} → ${apres.n}`);
  check("… et le rafraîchissement le compte comme changé", changees >= 1, String(changees));
  // Le parent doit baisser d'autant : c'est la descente récursive qui le fait.
  const { rows: [{ juste }] } = await db.query(
    `WITH reel AS (${REEL})
     SELECT bool_and(loc.listing_count = COALESCE(r.n, 0)) AS juste
       FROM locations loc LEFT JOIN reel r ON r.id = loc.id`);
  check("les ascendants suivent, à tous les niveaux", juste === true);
}

// La descente doit valoir à n'importe quelle profondeur : l'ancien calcul
// joignait la localité, ses enfants et ses petits-enfants en dur, et un
// quatrième niveau serait passé au travers sans que rien ne le signale.
const { rows: [profond] } = await db.query(`
  SELECT loc.id, loc.parent_id FROM locations loc
   WHERE loc.parent_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM properties p JOIN listings l ON l.property_id = p.id
                  AND l.status = 'active' WHERE p.location_id = loc.id)
   LIMIT 1`);
if (profond) {
  const { rows: [enfant] } = await db.query(
    `INSERT INTO locations(parent_id, level, slug, name_i18n, geo_center)
     SELECT id, 'neighborhood', 'chk-profond', '{"en":"Contrôle"}'::jsonb, geo_center
       FROM locations WHERE id = $1 RETURNING id`, [profond.id]);
  await db.query(`UPDATE properties SET location_id = $1 WHERE location_id = $2`,
    [enfant.id, profond.id]);
  await refreshLocationCounts(db);
  const { rows: [{ juste }] } = await db.query(
    `WITH reel AS (${REEL})
     SELECT bool_and(loc.listing_count = COALESCE(r.n, 0)) AS juste
       FROM locations loc LEFT JOIN reel r ON r.id = loc.id`);
  check("un niveau de plus dans l'arbre est compté quand même", juste === true);
}
await db.query("ROLLBACK");

const apresRollback = await derive();
check("le contrôle laisse la base comme il l'a trouvée", apresRollback.n === avant.n);

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
