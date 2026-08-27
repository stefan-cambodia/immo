#!/usr/bin/env node
/**
 * Vérifie les pages promoteurs et projets neufs (phase 3).
 *
 * Contrairement aux atterrissages quartier × type, chaque projet a un contenu
 * propre (étages, unités, statut, promoteur) : toutes les fiches sont
 * indexables et présentes dans le sitemap, y compris un projet sans annonce
 * active — c'est précisément ce qu'un acheteur sur plan cherche.
 *
 *   node db/checks/projects.mjs [--base http://localhost:3111]
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

// ------------------------------------------------------------------- Hub
console.log("Hub des projets");
const hub = await fetch(`${BASE}/en/projects`);
check("/en/projects répond", hub.status === 200, String(hub.status));
const hubHtml = await hub.text();

const { rows: buildings } = await db.query(`
  SELECT b.slug, b.name_i18n->>'en' AS name, b.status::text AS status,
         (SELECT count(*) FROM properties p
          JOIN listings l ON l.property_id = p.id AND l.status = 'active'
          WHERE p.building_id = b.id)::int AS listings
  FROM buildings b ORDER BY b.slug`);
check("tous les projets sont listés sur le hub",
      buildings.every((b) => hubHtml.includes(`/en/project/${b.slug}`)),
      buildings.filter((b) => !hubHtml.includes(`/en/project/${b.slug}`)).map((b) => b.slug).join(", "));

const wip = buildings.filter((b) => b.status !== "completed");
check("les chantiers en cours existent en base", wip.length > 0, "aucun");

// ------------------------------------------------------- Fiche projet
console.log("\nFiche projet");
// Les annonces collectées ne sont pas rattachées à un immeuble : seul le jeu
// engendré fournit un projet avec annonces.
const withListings = buildings.find((b) => b.listings > 0);
check("le seed fournit un projet avec annonces", Boolean(withListings), "lancer npm run db:seed");
if (withListings) {
  const rich = await (await fetch(`${BASE}/en/project/${withListings.slug}`)).text();
  check(`la fiche porte le nom du projet (${withListings.slug})`,
        rich.includes(withListings.name), withListings.name);
  check("données structurées ApartmentComplex", rich.includes("ApartmentComplex"), "");
  check("la fiche liste des annonces", rich.includes("/en/property/"), "");
}

// Un projet sans annonce reste consultable et indexable.
const empty = buildings.find((b) => b.listings === 0);
if (empty) {
  const res = await fetch(`${BASE}/en/project/${empty.slug}`);
  const html = await res.text();
  check(`projet sans annonce consultable (${empty.slug})`, res.status === 200, String(res.status));
  check("projet sans annonce non désindexé", !/noindex/.test(html), "noindex trouvé");
} else {
  console.log("  (aucun projet sans annonce dans le jeu de données — cas non testé)");
}

const missing = await fetch(`${BASE}/en/project/does-not-exist`);
check("projet inconnu → 404", missing.status === 404, String(missing.status));

console.log("\nBalises par langue");
const anyProject = withListings ?? buildings[0];
const fr = await (await fetch(`${BASE}/fr/project/${anyProject.slug}`)).text();
for (const lang of ["fr", "en", "zh-Hans", "km"]) {
  check(`hreflang ${lang}`, fr.includes(`hrefLang="${lang}"`), "");
}
check("x-default présent", fr.includes('hrefLang="x-default"'), "");

// ------------------------------------------------------ Fiche promoteur
console.log("\nFiche promoteur");
const { rows: [dev] } = await db.query(`
  SELECT d.slug, d.name, count(b.id)::int AS projects
  FROM developers d JOIN buildings b ON b.developer_id = d.id
  GROUP BY d.id ORDER BY count(b.id) DESC LIMIT 1`);
const devHtml = await (await fetch(`${BASE}/en/developer/${dev.slug}`)).text();
check(`la fiche promoteur porte son nom (${dev.slug})`, devHtml.includes(dev.name), dev.name);
const linked = (devHtml.match(/\/en\/project\//g) ?? []).length;
check(`elle relie ses ${dev.projects} projets`, linked >= dev.projects, String(linked));

// ------------------------------------------------------------- Sitemap
console.log("\nSitemap");
const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
check("le hub est dans le sitemap", xml.includes("/en/projects"), "");
check("chaque projet est dans le sitemap",
      buildings.every((b) => xml.includes(`/en/project/${b.slug}`)),
      buildings.filter((b) => !xml.includes(`/en/project/${b.slug}`)).map((b) => b.slug).join(", "));
check("le promoteur est dans le sitemap", xml.includes(`/en/developer/${dev.slug}`), "");

await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
