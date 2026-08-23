#!/usr/bin/env node
/**
 * Vérifie le comparateur de biens (phase 4).
 *
 * La sélection vit dans l'URL : elle se partage et fonctionne sans
 * JavaScript. Le comparateur réutilise les définitions de l'estimateur
 * (position sur la médiane, rendement brut) — il ne recalcule rien à sa
 * façon. Et la combinatoire étant infinie, la page reste hors index.
 *
 *   node db/checks/compare.mjs [--base http://localhost:3111]
 */
import pg from "pg";

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

// Cinq biens à vendre d'un quartier fourni, pour tester colonnes et plafond.
const { rows: sale } = await db.query(`
  SELECT p.reference FROM properties p
  JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'sale'
  JOIN locations loc ON loc.id = p.location_id AND loc.slug = 'bkk1'
  WHERE p.property_type = 'condo' AND COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
  GROUP BY p.reference ORDER BY p.reference LIMIT 5`);
const { rows: [rent] } = await db.query(`
  SELECT p.reference FROM properties p
  JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'rent'
  GROUP BY p.reference ORDER BY p.reference LIMIT 1`);
check("jeu de données suffisant", sale.length >= 3 && Boolean(rent),
      `${sale.length} ventes, ${rent ? 1 : 0} location`);

// ---------------------------------------------------------- Comparaison
console.log("Comparaison");
const [a, b] = [sale[0].reference, sale[1].reference];
const html = await (await fetch(`${BASE}/en/compare?refs=${a},${b}`)).text();
check("les deux biens sont en colonnes", html.includes(a) && html.includes(b), "");
check("le prix est comparé", html.includes(">Price<"), "");
check("chaque bien est situé sur la médiane du secteur", html.includes("area median"), "");
check("le rendement brut est présent pour des biens à vendre",
      html.includes("gross rental yield"), "");
check("hors index", html.includes('name="robots" content="noindex'), "");
// Compté sur le HTML rendu : « </a> » ne peut pas apparaître dans le
// payload RSC inliné (le < y est échappé), donc pas de double compte.
const removeLinks = (h) => (h.match(/✕ <!-- -->Remove<\/a>/g) ?? []).length;
check("un lien de retrait par colonne", removeLinks(html) === 2, String(removeLinks(html)));

// Mélange vente + location : autorisé, le loyer est affiché par mois.
const mixed = await (await fetch(`${BASE}/en/compare?refs=${a},${rent.reference}`)).text();
check("mélange vente + location accepté",
      mixed.includes(a) && mixed.includes(rent.reference), "");
check("le loyer est affiché par mois", /\$[\d,]+ \/ month/.test(mixed), "");

// ---------------------------------------------------------- Robustesse
console.log("\nRobustesse");
const unknown = await fetch(`${BASE}/en/compare?refs=${a},ZZ-NOPE99`);
const unknownHtml = await unknown.text();
check("référence inconnue signalée sans casser la page",
      unknown.status === 200 && unknownHtml.includes("Unknown reference"), String(unknown.status));

const merged = await (await fetch(
  `${BASE}/en/compare?refs=${a}&add=${b.toLowerCase()}`)).text();
check("le formulaire d'ajout fusionne et normalise la casse",
      merged.includes(b), b);

const five = await (await fetch(
  `${BASE}/en/compare?refs=${sale.map((r) => r.reference).join(",")}`)).text();
check("au-delà de 4 : plafonné et annoncé",
      five.includes("Only the first 4") && removeLinks(five) === 4,
      String(removeLinks(five)));

const empty = await fetch(`${BASE}/en/compare`);
check("page vide consultable avec mode d'emploi",
      empty.status === 200 && (await empty.text()).includes("Compare with similar"),
      String(empty.status));

// ---------------------------------------------------------- Point d'entrée
console.log("\nPoint d'entrée");
const propHtml = await (await fetch(`${BASE}/en/property/${a}`)).text();
const link = propHtml.match(/\/en\/compare\?refs=([A-Z0-9,-]+)/)?.[1];
check("la fiche bien relie vers une comparaison préremplie", Boolean(link), "");
check("la sélection préremplie commence par le bien courant",
      link?.startsWith(a) ?? false, String(link));

await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
