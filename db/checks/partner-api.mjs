#!/usr/bin/env node
/**
 * Vérifie l'API partenaires (phase 4).
 *
 * Le contrat qui compte : une clé inconnue est refusée (401), une clé fermée
 * est expliquée (403), le quota journalier coupe (429), et ce qui sort est la
 * fiche Property agrégée — jamais de coordonnée d'agent, dans aucune réponse.
 *
 * La partie clés/quota tourne dans une transaction annulée à la fin ; la
 * partie HTTP crée un partenaire temporaire committé (le serveur doit le
 * voir), interroge le serveur de développement, puis le supprime.
 *
 *   node db/checks/partner-api.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import { authenticateApiKey, consumeApiQuota, createApiPartner, generateApiKey,
         hashApiKey, issueApiKey, revokeApiKey } from "../lib/partner-api.mjs";

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

// ------------------------------------------------- Clés et quota (en base)
console.log("Clés et quota");
await db.query("BEGIN");

const gen = generateApiKey();
check("la clé générée porte le schéma et son préfixe",
      gen.key.startsWith("ci_") && gen.key.startsWith(gen.prefix)
        && gen.hash === hashApiKey(gen.key) && !gen.prefix.includes(gen.key.slice(11)),
      JSON.stringify({ prefix: gen.prefix }));

const partner = await createApiPartner(db, {
  slug: "chk-partner", name: "Partenaire de contrôle", contact: "chk@example.org" });
check("un partenaire se crée", Boolean(partner?.id));
check("un slug déjà pris est refusé sans erreur",
      (await createApiPartner(db, { slug: "chk-partner", name: "Doublon" })) === null);

const issued = await issueApiKey(db, { partnerId: partner.id, label: "test", dailyQuota: 3 });
check("une clé s'émet avec sa valeur en clair", issued?.key?.startsWith("ci_"));
const { rows: [stored] } = await db.query(
  `SELECT key_hash, key_prefix FROM api_keys WHERE id = $1`, [issued.id]);
check("la base ne garde que le hachage et le préfixe",
      stored.key_hash === hashApiKey(issued.key) && stored.key_prefix === issued.key.slice(0, 11)
        && stored.key_hash !== issued.key);

const auth = await authenticateApiKey(db, issued.key);
check("la clé authentifie son partenaire",
      auth?.ok === true && auth.partnerSlug === "chk-partner" && auth.dailyQuota === 3,
      JSON.stringify(auth));
check("une clé inconnue est rejetée",
      (await authenticateApiKey(db, "ci_" + "x".repeat(32))) === null);
check("une valeur sans schéma est rejetée sans requête",
      (await authenticateApiKey(db, "Bearer nimporte")) === null);

// Quota de 3 : trois passages, puis solde négatif.
const remainders = [];
for (let i = 0; i < 4; i++) remainders.push(await consumeApiQuota(db, issued.id));
check("le quota décompte puis coupe",
      remainders.join(",") === "2,1,0,-1", remainders.join(","));
const { rows: [usage] } = await db.query(
  `SELECT count, (SELECT last_used_at FROM api_keys WHERE id = key_id) IS NOT NULL AS used
   FROM api_usage WHERE key_id = $1 AND day = current_date`, [issued.id]);
check("les refus restent comptés et la clé est datée",
      usage.count === 4 && usage.used === true, JSON.stringify(usage));

const revoked = await revokeApiKey(db, issued.id);
check("la clé se révoque", revoked?.id === issued.id);
check("la révocation est idempotente", (await revokeApiKey(db, issued.id)) === null);
const refused = await authenticateApiKey(db, issued.key);
check("une clé révoquée est reconnue mais fermée",
      refused?.ok === false && refused.reason === "key_revoked", JSON.stringify(refused));

await db.query(`UPDATE api_keys SET revoked_at = NULL WHERE id = $1`, [issued.id]);
await db.query(`UPDATE api_partners SET active = false WHERE id = $1`, [partner.id]);
const inactive = await authenticateApiKey(db, issued.key);
check("un partenaire désactivé ferme toutes ses clés",
      inactive?.ok === false && inactive.reason === "partner_inactive", JSON.stringify(inactive));

await db.query("ROLLBACK");

// ------------------------------------------------------- Contrat HTTP
console.log("\nContrat HTTP");
// Partenaire temporaire committé : le serveur de développement lit la même
// base mais pas la même transaction.
const { rows: [httpPartner] } = await db.query(
  `INSERT INTO api_partners(slug, name) VALUES ('chk-http', 'Contrôle HTTP') RETURNING id`);
const httpKey = await issueApiKey(db, { partnerId: httpPartner.id, label: "chk", dailyQuota: 100 });

try {
  const call = (path, key = httpKey.key) =>
    fetch(`${BASE}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

  check("sans clé : 401", (await call("/api/partner/v1/properties", null)).status === 401);
  check("clé inconnue : 401",
        (await call("/api/partner/v1/properties", "ci_" + "y".repeat(32))).status === 401);

  const list = await call("/api/partner/v1/properties?limit=5");
  const listBody = await list.json();
  check("la liste répond avec données et quota",
        list.status === 200 && Array.isArray(listBody.data) && listBody.data.length === 5
          && list.headers.get("x-ratelimit-limit") === "100"
          && Number(list.headers.get("x-ratelimit-remaining")) < 100,
        `status ${list.status} — lancer npm run db:seed et le serveur dev`);
  const fiche = listBody.data[0] ?? {};
  check("la fiche est le Property agrégé (§3.3)",
        typeof fiche.reference === "string" && Array.isArray(fiche.offers)
          && fiche.offers.every((o) => o.agency_count >= 1 && o.price_min_usd <= o.price_max_usd)
          && fiche.location?.slug && fiche.geo?.lng,
        JSON.stringify(fiche).slice(0, 200));
  check("pagination par curseur", typeof listBody.next_cursor === "string");
  const page2 = await (await call(
    `/api/partner/v1/properties?limit=5&cursor=${encodeURIComponent(listBody.next_cursor)}`)).json();
  check("la page suivante avance sans recouvrement",
        page2.data.length > 0 && page2.data.every((p) => p.reference > listBody.next_cursor));

  const eligible = await (await call(
    "/api/partner/v1/properties?foreign_eligible=1&limit=50")).json();
  check("le filtre éligible étranger (§5.3) est appliqué",
        eligible.data.length > 0 && eligible.data.every((p) => p.foreign_eligible === true));

  const badParam = await call("/api/partner/v1/properties?transaction=lease");
  check("un paramètre invalide vaut 400 nommé",
        badParam.status === 400 && (await badParam.json()).parameter === "transaction");
  check("des bornes de prix sans transaction valent 400",
        (await call("/api/partner/v1/properties?price_min=1000")).status === 400);

  const detail = await (await call(`/api/partner/v1/properties/${fiche.reference}`)).json();
  check("la fiche détaillée liste les annonces avec l'agence",
        Array.isArray(detail.listings) && detail.listings.length > 0
          && detail.listings.every((l) => l.agency?.name && typeof l.price_usd === "number")
          && Array.isArray(detail.media),
        JSON.stringify(detail).slice(0, 200));
  const everything = JSON.stringify(listBody) + JSON.stringify(detail);
  check("aucune coordonnée d'agent ne sort (§8)",
        !/phone|telegram|wechat/i.test(everything));
  check("référence inconnue : 404",
        (await call("/api/partner/v1/properties/CHK-INTROUVABLE")).status === 404);

  const locations = await (await call("/api/partner/v1/locations")).json();
  const bkk1 = locations.data.find((l) => l.slug === "bkk1");
  check("le référentiel des localités porte les alias (§5.2)",
        locations.data.length > 10 && Array.isArray(bkk1?.aliases) && bkk1.aliases.length > 0,
        JSON.stringify(bkk1));

  await db.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [httpKey.id]);
  check("une clé révoquée : 403 explicite",
        (await call("/api/partner/v1/properties")).status === 403);

  await db.query(`UPDATE api_keys SET revoked_at = NULL, daily_quota = 1 WHERE id = $1`,
    [httpKey.id]);
  await call("/api/partner/v1/properties?limit=1"); // consomme le quota restant
  const over = await call("/api/partner/v1/properties?limit=1");
  check("quota épuisé : 429 avec l'heure de remise à zéro",
        over.status === 429 && Number(over.headers.get("x-ratelimit-reset")) > 0,
        String(over.status));
} finally {
  // Le partenaire de contrôle ne survit pas au contrôle (cascade sur clés et usage).
  await db.query(`DELETE FROM api_partners WHERE slug = 'chk-http'`);
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
