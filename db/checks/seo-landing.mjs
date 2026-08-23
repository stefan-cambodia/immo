#!/usr/bin/env node
/**
 * Vérifie la cohérence des pages d'atterrissage (phase 3).
 *
 * L'invariant central : le sitemap et la balise `robots` doivent porter sur
 * exactement le même ensemble. Annoncer dans le sitemap une page qu'on demande
 * par ailleurs à Google d'ignorer est une contradiction qui coûte du budget
 * d'exploration et de la crédibilité.
 *
 *   node db/checks/seo-landing.mjs [--base http://localhost:3111]
 */
import pg from "pg";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");
const THRESHOLD = 5;

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const robotsOf = async (path) => {
  const html = await (await fetch(BASE + path)).text();
  const m = html.match(/<meta name="robots" content="([^"]*)"/);
  return m ? m[1] : null;
};

console.log("Sitemap et indexation");
const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const landing = urls.filter((u) => /\/(buy|rent)\//.test(u));
check("le sitemap contient des pages d'atterrissage", landing.length > 0, String(landing.length));

// Chaque URL annoncée doit être réellement indexable.
let contradictions = 0;
for (const url of landing.slice(0, 12)) {
  const robots = await robotsOf(new URL(url).pathname);
  if (robots?.includes("noindex")) contradictions++;
}
check("aucune page du sitemap n'est en noindex", contradictions === 0, `${contradictions} contradiction(s)`);

// Une combinaison sous le seuil : consultable, mais hors index et hors sitemap.
const { rows: [thin] } = await db.query(`
  SELECT loc.slug AS area, p.property_type::text AS type, count(DISTINCT p.id)::int AS n
  FROM properties p
  JOIN locations loc ON loc.id = p.location_id
  JOIN listings l ON l.property_id = p.id AND l.status='active' AND l.transaction_type='sale'
  GROUP BY 1,2 HAVING count(DISTINCT p.id) BETWEEN 1 AND $1 - 1
  ORDER BY 3 LIMIT 1`, [THRESHOLD]);
const thinPath = `/en/buy/${thin.area}/${thin.type}`;
const thinRes = await fetch(BASE + thinPath);
check(`page mince consultable (${thin.n} bien) : ${thinPath}`, thinRes.status === 200, String(thinRes.status));
check("page mince en noindex, follow",
      (await robotsOf(thinPath))?.includes("noindex"), String(await robotsOf(thinPath)));
check("page mince absente du sitemap",
      !urls.some((u) => u.endsWith(thinPath)), thinPath);

// Une combinaison au-dessus du seuil : indexable et présente.
const { rows: [rich] } = await db.query(`
  SELECT loc.slug AS area, p.property_type::text AS type, count(DISTINCT p.id)::int AS n
  FROM properties p
  JOIN locations loc ON loc.id = p.location_id
  JOIN listings l ON l.property_id = p.id AND l.status='active' AND l.transaction_type='sale'
  GROUP BY 1,2 HAVING count(DISTINCT p.id) >= $1
  ORDER BY 3 DESC LIMIT 1`, [THRESHOLD]);
const richPath = `/en/buy/${rich.area}/${rich.type}`;
check(`page fournie indexable (${rich.n} biens) : ${richPath}`,
      !(await robotsOf(richPath))?.includes("noindex"), String(await robotsOf(richPath)));
check("page fournie présente dans le sitemap",
      urls.some((u) => u.endsWith(richPath)), richPath);

console.log("\nBalises par langue");
const html = await (await fetch(`${BASE}/fr/buy/${rich.area}/${rich.type}`)).text();
check("canonical pointe la version française",
      html.includes(`rel="canonical" href="http://localhost:3000/fr/buy/${rich.area}/${rich.type}"`), "");
for (const lang of ["fr", "en", "zh-Hans", "km"]) {
  check(`hreflang ${lang}`, html.includes(`hrefLang="${lang}"`), "");
}
check("x-default présent", html.includes('hrefLang="x-default"'), "");

console.log("\nContenu");
const bodies = {};
for (const area of ["bkk1", "tuol-tumpung"]) {
  bodies[area] = await (await fetch(`${BASE}/en/buy/${area}`)).text();
}
const intro = (h) => (h.match(/(\d[\d,]* verified properties, offered by \d+ agencies\.[^<]*)/) ?? [])[1];
check("le texte est écrit depuis les chiffres du quartier",
      Boolean(intro(bodies.bkk1)) && intro(bodies.bkk1) !== intro(bodies["tuol-tumpung"]),
      `${intro(bodies.bkk1)} / ${intro(bodies["tuol-tumpung"])}`);
check("données structurées BreadcrumbList + ItemList",
      bodies.bkk1.includes("BreadcrumbList") && bodies.bkk1.includes("ItemList"), "");
check("maillage interne vers d'autres types",
      /href="\/en\/buy\/bkk1\/[a-z_]+"/.test(bodies.bkk1), "");

console.log("\nRoutes existantes non masquées");
for (const [path, expected] of [["/en/search", 200], ["/en/login", 200],
                                ["/en/agency/ips-cambodia", 200], ["/en/foo/bar", 404]]) {
  const res = await fetch(BASE + path, { redirect: "manual" });
  check(`${path} → ${expected}`, res.status === expected, String(res.status));
}

await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
