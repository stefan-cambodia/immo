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
import { sweep, buildingWithListings } from "./fixtures.mjs";
import { createFromProject, findByProjectSlug, linkProject, projectProperties,
         purgeProjectBuildings } from "../lib/buildings.mjs";

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
await sweep(db);

// ------------------------------------------------------------------- Hub
console.log("Hub des projets");
const hub = await fetch(`${BASE}/en/projects`);
check("/en/projects répond", hub.status === 200, String(hub.status));
const hubHtml = await hub.text();

const { rows: buildings } = await db.query(`
  SELECT b.slug, b.name_i18n->>'en' AS name, b.status::text AS status,
         b.created_at AS "createdAt",
         (SELECT count(*) FROM properties p
          JOIN listings l ON l.property_id = p.id AND l.status = 'active'
          WHERE p.building_id = b.id)::int AS listings
  FROM buildings b ORDER BY b.slug`);

// Le hub est régénéré toutes les 900 secondes, le sitemap toutes les 3 600, et
// Next sert la version périmée pendant qu'il refait la neuve : un projet créé
// à l'instant — la collecte en crée — en est légitimement absent le temps
// d'une fenêtre. Sans cette réserve, le contrôle échoue une fois puis passe,
// ce qui est le pire des deux mondes : il ne dit rien de juste et on apprend
// à ne pas le croire. Au-delà de sa fenêtre, une absence reste un défaut.
const settled = (seconds) => buildings.filter(
  (b) => Date.now() - new Date(b.createdAt).getTime() > seconds * 1000);
const missingFrom = (html, list) =>
  list.filter((b) => !html.includes(`/en/project/${b.slug}`)).map((b) => b.slug);

const onHub = settled(900);
check(`tous les projets sont listés sur le hub (${onHub.length})`,
      missingFrom(hubHtml, onHub).length === 0, missingFrom(hubHtml, onHub).join(", "));

const wip = buildings.filter((b) => b.status !== "completed");
check("les chantiers en cours existent en base", wip.length > 0, "aucun");

// ------------------------------------------------------- Fiche projet
console.log("\nFiche projet");
// Un projet portant des annonces. Les annonces collectées sur un portail ne
// sont rattachées à aucun immeuble ; à défaut d'en trouver un peuplé, le
// contrôle en fabrique un et lui rattache de vrais biens le temps de la
// lecture. Il est créé après le relevé du hub et du sitemap, qui portent sur
// les projets de la base et n'ont pas à connaître celui-ci.
const populated = buildings.find((b) => b.listings > 0);
const withListings = populated ?? await buildingWithListings(db);
check("un projet porte des annonces", Boolean(withListings), "aucune annonce à vendre en base");
if (!populated && withListings) console.log(
  "  (aucun projet peuplé en base : le contrôle en a fabriqué un — les annonces"
  + " collectées ne nomment pas leur immeuble)");
try {
  if (withListings) {
    const rich = await (await fetch(`${BASE}/en/project/${withListings.slug}`)).text();
    check(`la fiche porte le nom du projet (${withListings.slug})`,
          rich.includes(withListings.name), withListings.name);
    check("données structurées ApartmentComplex", rich.includes("ApartmentComplex"), "");
    check("la fiche liste des annonces", rich.includes("/en/property/"), "");
  }
} finally {
  // Un immeuble de contrôle laissé en base apparaîtrait sur le hub des projets
  // et dans le sitemap : il part même si une assertion a levé.
  await withListings?.release?.();
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
const anyProject = buildings[0];
const fr = await (await fetch(`${BASE}/fr/project/${anyProject.slug}`)).text();
for (const lang of ["fr", "en", "zh-Hans", "km", "ru"]) {
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
const inSitemap = settled(3600);
check(`chaque projet est dans le sitemap (${inSitemap.length})`,
      missingFrom(xml, inSitemap).length === 0, missingFrom(xml, inSitemap).join(", "));
check("le promoteur est dans le sitemap", xml.includes(`/en/developer/${dev.slug}`), "");

// ------------------------------------ Rattachement au programme collecté
// Le portail range les annonces d'un immeuble neuf sous l'adresse du
// programme ; ces vérifications portent sur ce que la base en fait. Tout se
// passe dans une transaction annulée, sur de vrais biens.
console.log("\nRattachement au programme collecté");
await db.query("BEGIN");
const { rows: [collected] } = await db.query(
  `SELECT b.id, b.slug, count(p.id)::int AS biens
     FROM buildings b JOIN properties p ON p.building_id = b.id
    WHERE b.source_url IS NOT NULL
    GROUP BY b.id, b.slug ORDER BY count(p.id) DESC LIMIT 1`);
check("un programme collecté porte des biens", Boolean(collected),
      "lancer npm run projects:link -- --fetch");
if (collected) {
  check("l'immeuble se retrouve par son slug exact",
        (await findByProjectSlug(db, collected.slug))?.id === collected.id);
  // La source publie côte à côte `urban-village-phase-1` et `urban-village` :
  // un rapprochement approché rangerait les unes sous l'autre.
  check("un slug voisin ne le retrouve pas",
        (await findByProjectSlug(db, collected.slug + "-phase-9")) === null
          && (await findByProjectSlug(db, collected.slug.slice(0, -1))) === null);

  // Détaché puis reconstruit depuis ses propres unités.
  await db.query(`UPDATE properties SET building_id = NULL WHERE building_id = $1`, [collected.id]);
  await db.query(`DELETE FROM buildings WHERE id = $1`, [collected.id]);
  const pending = await projectProperties(db, collected.slug);
  check("ses biens redeviennent des candidats", pending.length === collected.biens,
        `${pending.length} vs ${collected.biens}`);

  const rebuilt = await createFromProject(db, {
    slug: collected.slug, name: "Contrôle Programme",
    url: `https://source.test/new-developments/${collected.slug}/` });
  const { rows: [made] } = await db.query(
    `SELECT status::text AS status, source_url AS "sourceUrl", name_i18n AS name,
            location_id IS NOT NULL AS "hasLocation", geo_point IS NOT NULL AS "hasPoint"
       FROM buildings WHERE id = $1`, [rebuilt.id]);
  // La source ne dit pas où en est le chantier : la fiche ne doit pas
  // annoncer « achevé », qui est justement ce qu'un acheteur sur plan vérifie.
  check("l'immeuble créé n'affirme pas son état d'avancement", made.status === "unknown", made.status);
  check("il porte l'adresse de la source, pour l'attribution et la purge",
        String(made.sourceUrl).includes("/new-developments/"), String(made.sourceUrl));
  check("son nom est le même dans les quatre langues",
        new Set(["fr", "en", "zh-Hans", "km"].map((l) => made.name[l])).size === 1,
        JSON.stringify(made.name));
  check("sa localité et son point sont dérivés de ses unités",
        made.hasLocation && made.hasPoint);

  const linked = await linkProject(db, { buildingId: rebuilt.id, slug: collected.slug });
  check("tous ses biens s'y rattachent", linked === collected.biens, `${linked}`);
  check("un second passage ne rattache rien de plus",
        (await linkProject(db, { buildingId: rebuilt.id, slug: collected.slug })) === 0);

  // La purge : un immeuble collecté encore occupé reste, vidé il part.
  const stillThere = async () =>
    (await db.query(`SELECT 1 FROM buildings WHERE id = $1`, [rebuilt.id])).rowCount === 1;
  await purgeProjectBuildings(db);
  check("occupé, il survit à la purge", await stillThere());
  await db.query(`UPDATE properties SET building_id = NULL WHERE building_id = $1`, [rebuilt.id]);
  await purgeProjectBuildings(db);
  check("vidé, la purge l'emporte", !(await stillThere()));
  // Un immeuble saisi à la main n'a pas d'adresse de source : la purge d'un
  // portail ne doit pas y toucher.
  check("un immeuble saisi à la main n'est pas emporté",
        (await db.query(`SELECT count(*)::int n FROM buildings WHERE source_url IS NULL`))
          .rows[0].n >= 22);
}
await db.query("ROLLBACK");

await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
