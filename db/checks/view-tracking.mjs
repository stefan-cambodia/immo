#!/usr/bin/env node
/**
 * Vérifie la mesure d'audience : dédoublonnage, filtrage des robots, respect
 * de la vie privée, et cohérence des chiffres du tableau de bord.
 *
 * Ces chiffres sont vendus aux agences. Un compteur qui gonfle est pire qu'une
 * absence de compteur : il fausse la décision d'achat dans le sens qui arrange
 * le vendeur.
 *
 *   node db/checks/view-tracking.mjs [--base http://localhost:3111]
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

const { rows: [prop] } = await db.query(`SELECT id FROM properties LIMIT 1`);
const session = "chk" + Math.random().toString(36).slice(2, 12);
const post = (body, headers = {}) =>
  fetch(`${BASE}/api/views`, {
    method: "POST",
    headers: { "content-type": "application/json",
               "user-agent": "Mozilla/5.0 (check)", ...headers },
    body: JSON.stringify(body),
  });

const countFor = async (s) => (await db.query(
  `SELECT count(*)::int n FROM property_views WHERE session_id = $1`, [s])).rows[0].n;

console.log("Comptage des vues");
await post({ propertyId: prop.id, locale: "en", session });
check("une vue est enregistrée", (await countFor(session)) === 1, String(await countFor(session)));

// Rechargements successifs dans la même heure.
for (let i = 0; i < 5; i++) await post({ propertyId: prop.id, locale: "en", session });
check("les rechargements de la même heure ne comptent qu'une fois",
      (await countFor(session)) === 1, String(await countFor(session)));

const other = session + "b";
await post({ propertyId: prop.id, locale: "km", session: other });
check("une autre session compte séparément", (await countFor(other)) === 1);

console.log("\nFiltrage");
const botSession = session + "bot";
for (const ua of ["Googlebot/2.1", "python-requests/2.31", "curl/8.0", "HeadlessChrome/120"]) {
  await post({ propertyId: prop.id, locale: "en", session: botSession }, { "user-agent": ua });
}
check("les robots ne sont pas comptés", (await countFor(botSession)) === 0,
      String(await countFor(botSession)));

const r1 = await post({ propertyId: "pas-un-uuid", locale: "en", session });
check("identifiant de bien invalide → 400", r1.status === 400, String(r1.status));
const r2 = await post({ propertyId: prop.id, locale: "en", session: "x" });
check("session trop courte → 400", r2.status === 400, String(r2.status));
const r3 = await post({ propertyId: prop.id, locale: "klingon", session });
check("locale inconnue → 400", r3.status === 400, String(r3.status));

console.log("\nVie privée");
const cols = (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'property_views'`))
  .rows.map((r) => r.column_name);
check("aucune colonne d'adresse IP", !cols.some((c) => /\bip\b|address/i.test(c)), cols.join(","));
check("aucune colonne d'agent utilisateur", !cols.includes("user_agent"), cols.join(","));
await post({ propertyId: prop.id, locale: "en", session: session + "ref" },
            { referer: "https://www.google.com/search?q=condo+bkk1+secret" });
const { rows: [ref] } = await db.query(
  `SELECT referrer_host FROM property_views WHERE session_id = $1`, [session + "ref"]);
check("seul l'hôte du référent est conservé", ref?.referrer_host === "www.google.com",
      String(ref?.referrer_host));

console.log("\nCohérence des chiffres");
const { rows: [agency] } = await db.query(
  `SELECT a.id, a.name FROM agencies a
   JOIN listings l ON l.agency_id = a.id AND l.status='active'
   GROUP BY a.id, a.name ORDER BY count(*) DESC LIMIT 1`);
const { rows: [manual] } = await db.query(`
  SELECT (SELECT count(*) FROM property_views v
           WHERE v.created_at > now() - interval '30 days'
             AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = v.property_id
                           AND l.agency_id = $1 AND l.status='active'))::int AS views,
         (SELECT count(*) FROM leads WHERE agency_id = $1
           AND created_at > now() - interval '30 days')::int AS leads`, [agency.id]);
check("l'agence a du trafic à montrer", manual.views > 0 && manual.leads > 0,
      `${manual.views} vues / ${manual.leads} contacts`);
check("le taux de contact reste plausible",
      manual.leads / manual.views < 0.25,
      `${((manual.leads / manual.views) * 100).toFixed(1)} %`);

// Une vue porte sur un bien : les agences qui partagent le bien la partagent.
const { rows: [shared] } = await db.query(`
  SELECT v.property_id, count(DISTINCT l.agency_id)::int AS agencies
  FROM property_views v JOIN listings l ON l.property_id = v.property_id AND l.status='active'
  GROUP BY v.property_id HAVING count(DISTINCT l.agency_id) > 1 LIMIT 1`);
check("une vue sur un bien partagé profite à plusieurs agences",
      Boolean(shared) && shared.agencies > 1, String(shared?.agencies));

await db.query(`DELETE FROM property_views WHERE session_id LIKE $1`, [session.slice(0, 6) + "%"]);
await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
