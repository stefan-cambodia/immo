#!/usr/bin/env node
/**
 * Vérifie l'estimation de prix par quartier (phase 4).
 *
 * L'invariant central : le chiffre affiché doit être exactement celui que la
 * définition documentée produit — médiane du prix au m² des comparables
 * (même type, même transaction, annonce active ou partie depuis moins de
 * 6 mois, une valeur par bien), multipliée par la surface, arrondie au pas.
 * Le check recalcule la définition en SQL et compare à ce que la page rend.
 *
 * Et son garde-fou : sous le seuil de comparables, l'estimation s'élargit et
 * LE DIT ; la fiche bien se tait plutôt que d'afficher un écart calculé sur
 * trois biens.
 *
 *   node db/checks/estimate.mjs [--base http://localhost:3111]
 */
import pg from "pg";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");
const MIN_SAMPLE = 5;
const LOOKBACK_DAYS = 180;

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

// La même définition que src/lib/estimate.ts, réécrite indépendamment.
const STATS = `
  WITH RECURSIVE tree AS (
    SELECT id FROM locations WHERE slug = $1
    UNION ALL SELECT c.id FROM locations c JOIN tree ON c.parent_id = tree.id
  ),
  per_property AS (
    SELECT p.id, min(l.price_usd) AS price,
           COALESCE(p.indoor_area_sqm, p.land_area_sqm) AS area
    FROM properties p
    JOIN listings l ON l.property_id = p.id
      AND l.transaction_type = $2::transaction_type
      AND (l.status = 'active'
           OR (l.status IN ('expired','sold')
               AND l.updated_at > now() - interval '${LOOKBACK_DAYS} days'))
    WHERE p.property_type = $3::property_type
      AND COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
      AND p.location_id IN (SELECT id FROM tree)
    GROUP BY p.id
  )
  SELECT count(*)::int AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price / area)::float8 AS median
  FROM per_property`;

// ------------------------------------------------ Cohérence du calcul
console.log("Cohérence entre la page et la définition");

// Un quartier fourni : le calcul doit se faire au rang exact.
const { rows: [rich] } = await db.query(`
  SELECT loc.slug, p.property_type::text AS type, count(DISTINCT p.id)::int AS n
  FROM properties p
  JOIN locations loc ON loc.id = p.location_id AND loc.level = 'neighborhood'
  JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'sale'
  WHERE COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
  GROUP BY 1, 2 HAVING count(DISTINCT p.id) >= $1
  ORDER BY 3 DESC LIMIT 1`, [MIN_SAMPLE]);
check("un quartier au-dessus du seuil existe", Boolean(rich), "jeu de données trop mince");

const SQM = 100;
const { rows: [expected] } = await db.query(STATS, [rich.slug, "sale", rich.type]);
const expectedValue = Math.round((expected.median * SQM) / 500) * 500;

const url = `${BASE}/en/estimate?area=${rich.slug}&type=${rich.type}&sqm=${SQM}`;
const html = await (await fetch(url)).text();
const shown = html.match(/<data value="(\d+)" data-estimate/)?.[1];
check(`la page affiche l'estimation (${rich.slug}, ${rich.type}, ${SQM} m²)`,
      Boolean(shown), "pas de data-estimate dans la page");
check(`le chiffre affiché égale la définition (${expectedValue} $)`,
      Number(shown) === expectedValue, `${shown} ≠ ${expectedValue}`);
check("l'échantillon est annoncé", html.includes(`${expected.n} comparable`), String(expected.n));
check("aucun élargissement signalé au rang exact", !html.includes("Too few comparables"), "");

// ------------------------------------------------ Élargissement annoncé
console.log("\nÉlargissement sous le seuil");
const { rows: [thin] } = await db.query(`
  WITH counts AS (
    SELECT loc.id, loc.slug, t.type::text AS type,
      (SELECT count(DISTINCT p.id) FROM properties p
       JOIN listings l ON l.property_id = p.id AND l.status='active' AND l.transaction_type='sale'
       WHERE p.location_id = loc.id AND p.property_type = t.type::property_type
         AND COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0)::int AS here
    FROM locations loc, (SELECT unnest(enum_range(NULL::property_type))::text AS type) t
    WHERE loc.level = 'neighborhood' AND loc.listing_count > 0
  )
  SELECT slug, type, here FROM counts WHERE here BETWEEN 1 AND $1 - 1 LIMIT 1`, [MIN_SAMPLE]);
if (thin) {
  const thinHtml = await (await fetch(
    `${BASE}/en/estimate?area=${thin.slug}&type=${thin.type}&sqm=80`)).text();
  const widened = thinHtml.includes("Too few comparables");
  const silent = !thinHtml.includes("data-estimate");
  check(`combinaison mince (${thin.slug} × ${thin.type}) : élargie et annoncée, ou muette`,
        widened || silent, "estimation rendue sans mention d'élargissement");
} else {
  console.log("  (aucune combinaison mince dans le jeu de données — cas non testé)");
}

// ------------------------------------------------ Rendement locatif brut
console.log("\nRendement locatif brut");
const { rows: [both] } = await db.query(`
  WITH by_txn AS (
    SELECT loc.slug, p.property_type::text AS type, l.transaction_type::text AS txn,
           count(DISTINCT p.id)::int AS n
    FROM properties p
    JOIN locations loc ON loc.id = p.location_id AND loc.level = 'neighborhood'
    JOIN listings l ON l.property_id = p.id AND l.status = 'active'
    WHERE COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
    GROUP BY 1, 2, 3
  )
  SELECT s.slug, s.type FROM by_txn s
  JOIN by_txn r ON r.slug = s.slug AND r.type = s.type AND r.txn = 'rent'
  WHERE s.txn = 'sale' AND s.n >= $1 AND r.n >= $1
  ORDER BY s.n + r.n DESC LIMIT 1`, [MIN_SAMPLE]);

if (both) {
  const { rows: [saleStats] } = await db.query(STATS, [both.slug, "sale", both.type]);
  const { rows: [rentStats] } = await db.query(STATS, [both.slug, "rent", both.type]);
  const expectedYield = ((rentStats.median * 12) / saleStats.median * 100).toFixed(1);

  const yHtml = await (await fetch(
    `${BASE}/en/estimate?area=${both.slug}&type=${both.type}&sqm=${SQM}`)).text();
  const shownYield = yHtml.match(/<data value="([\d.]+)" data-yield/)?.[1];
  check(`le rendement affiché égale la définition (${both.slug} × ${both.type} : ${expectedYield} %)`,
        shownYield === expectedYield, `${shownYield} ≠ ${expectedYield}`);
  check("le rendement est annoncé comme brut", yHtml.includes("before fees, taxes and vacancy"), "");

  const rentHtml = await (await fetch(
    `${BASE}/en/estimate?area=${both.slug}&type=${both.type}&txn=rent&sqm=${SQM}`)).text();
  check("pas de rendement sur une estimation de loyer", !rentHtml.includes("data-yield"), "");

  // La page d'atterrissage achat × type du même quartier porte la statistique.
  const landing = await (await fetch(`${BASE}/en/buy/${both.slug}/${both.type}`)).text();
  check("la page d'atterrissage achat affiche le rendement du quartier",
        landing.includes("Gross yield") && landing.includes(`${expectedYield} %`),
        `attendu ${expectedYield} %`);

  const { rows: [saleProp] } = await db.query(`
    SELECT p.reference FROM properties p
    JOIN locations loc ON loc.id = p.location_id AND loc.slug = $1
    JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'sale'
    WHERE p.property_type = $2::property_type
      AND COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
    LIMIT 1`, [both.slug, both.type]);
  const salePropHtml = await (await fetch(`${BASE}/en/property/${saleProp.reference}`)).text();
  check(`la fiche d'un bien à vendre affiche son rendement (${saleProp.reference})`,
        salePropHtml.includes("gross rental yield"), "");
} else {
  console.log("  (aucune combinaison avec vente ET location au seuil — cas non testé)");
}

// ------------------------------------------------ Position sur la fiche
console.log("\nPosition du prix sur la fiche bien");
const { rows: [prop] } = await db.query(`
  SELECT p.reference FROM properties p
  JOIN locations loc ON loc.id = p.location_id AND loc.slug = $1
  JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'sale'
  WHERE p.property_type = $2::property_type
    AND COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
  LIMIT 1`, [rich.slug, rich.type]);
const propHtml = await (await fetch(`${BASE}/en/property/${prop.reference}`)).text();
check("la fiche situe le prix par rapport à la médiane du secteur",
      /area median/.test(propHtml), prop.reference);
check("elle relie vers l'estimateur prérempli",
      propHtml.includes(`/en/estimate?area=${rich.slug}`), "");

// ------------------------------------------------ Balises et sitemap
console.log("\nBalises et sitemap");
const bare = await (await fetch(`${BASE}/en/estimate`)).text();
check("canonical sans paramètres",
      bare.includes(`rel="canonical" href="http://localhost:3000/en/estimate"`), "");
for (const lang of ["fr", "en", "zh-Hans", "km"]) {
  check(`hreflang ${lang}`, bare.includes(`hrefLang="${lang}"`), "");
}
const withParams = html.includes(`rel="canonical" href="http://localhost:3000/en/estimate"`);
check("la variante paramétrée garde le même canonical", withParams, "");
const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
check("l'estimateur est dans le sitemap", xml.includes("/en/estimate"), "");

await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
