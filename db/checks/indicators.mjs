#!/usr/bin/env node
/**
 * Vérifie les indicateurs de santé du portail (§10 de la roadmap).
 *
 * Ce qui compte ici n'est pas qu'un chiffre s'affiche, mais qu'il soit
 * DÉFENDABLE. Un tableau de bord qui ment est pire que pas de tableau de bord :
 * il donne le sentiment de piloter. Le contrôle porte donc sur trois choses.
 *
 * 1. Les taux sont des taux. Un rapport paires/biens dépasse 100 % dès qu'un
 *    bien apparaît dans deux paires — le piège a été trouvé sur les données
 *    réelles, où la file de déduplication compte plus de paires que de biens.
 * 2. Ce qui n'est pas mesurable est déclaré tel quel, jamais rempli au jugé.
 * 3. Le panneau est réservé à la modération : une agence n'a pas à voir
 *    l'avancement du produit vers ses cibles.
 *
 *   node db/checks/indicators.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import { randomBytes, createHash } from "node:crypto";

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

// ------------------------------------------------------------- Définitions
console.log("Définitions");

const { rows: [n] } = await db.query(`
  SELECT
    (SELECT count(*) FROM properties)::int AS properties,
    (SELECT count(*) FROM listings WHERE status = 'active')::int AS active,
    (SELECT count(*) FROM dedup_candidates WHERE reviewed_at IS NULL)::int AS pairs,
    (SELECT count(*) FROM (
       SELECT property_a_id AS id FROM dedup_candidates WHERE reviewed_at IS NULL
       UNION
       SELECT property_b_id FROM dedup_candidates WHERE reviewed_at IS NULL) x)::int AS flagged,
    (SELECT count(*) FROM listings
      WHERE status = 'active' AND last_confirmed_at > now() - interval '30 days')::int AS confirmed
`);

check("le jeu de données porte des biens et des annonces actives",
      n.properties > 0 && n.active > 0, JSON.stringify(n));
check("les biens signalés en doublon ne dépassent jamais les biens",
      n.flagged <= n.properties, `${n.flagged} > ${n.properties}`);
check("le taux de doublons résiduels reste un pourcentage",
      n.properties === 0 || (n.flagged / n.properties) * 100 <= 100);
check("les annonces confirmées récemment sont un sous-ensemble des actives",
      n.confirmed <= n.active, `${n.confirmed} > ${n.active}`);
// Le piège qui a motivé ce contrôle : sur les données réelles, la file compte
// plus de paires que de biens. Rapporter les paires aux biens donnait 455 %.
check("la file de déduplication peut compter plus de paires que de biens",
      n.pairs >= 0 && (n.pairs <= n.properties || n.flagged <= n.properties),
      `${n.pairs} paires, ${n.properties} biens`);

// ------------------------------------------------------------------- Accès
console.log("Accès au panneau");

const session = async (userId) => {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await db.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [hash, userId]);
  return { token, hash };
};

const { rows: [admin] } = await db.query(
  `SELECT id FROM users WHERE role = 'admin' AND active LIMIT 1`);
const { rows: [agency] } = await db.query(
  `SELECT id FROM users WHERE role = 'agency' AND active LIMIT 1`);
check("le seed fournit un compte de modération et un compte d'agence",
      Boolean(admin && agency), "lancer npm run db:seed-base");

const sessions = [];
const fetchBackoffice = async (userId) => {
  const s = await session(userId);
  sessions.push(s.hash);
  const res = await fetch(`${BASE}/fr/backoffice`, { headers: { cookie: `bo_session=${s.token}` } });
  return { status: res.status, html: await res.text() };
};

const asAdmin = await fetchBackoffice(admin.id);
check("la modération voit le panneau", asAdmin.status === 200
      && asAdmin.html.includes("Indicateurs de santé"), String(asAdmin.status));

const asAgency = await fetchBackoffice(agency.id);
check("une agence ne le voit pas", asAgency.status === 200
      && !asAgency.html.includes("Indicateurs de santé"), String(asAgency.status));

const anon = await fetch(`${BASE}/fr/backoffice`, { redirect: "manual" });
check("sans session : renvoi vers la connexion",
      anon.status === 307 || anon.status === 303 || anon.status === 302,
      String(anon.status));

// ------------------------------------------------------------------ Valeurs
console.log("Valeurs affichées");

const html = asAdmin.html;
// La fenêtre couvre la ligne entière : libellé, famille, détail, valeur et
// cible sont séparés par des attributs de style verbeux.
const shown = (label) => {
  const at = html.indexOf(label);
  return at < 0 ? null : html.slice(at, at + 900);
};

check("les biens actifs affichent le compte de la base",
      (shown("Biens actifs") ?? "").includes(String(n.active)),
      `attendu ${n.active}`);
check("chaque indicateur porte sa cible ou son absence de mesure",
      ["cible ≥", "cible ≤", "non mesuré", "à établir"].every((s) => html.includes(s)));
check("le LCP est déclaré non mesuré, pas inventé",
      (shown("LCP p75 mobile") ?? "").includes("non mesuré"));
check("les recherches sans résultat le sont aussi, faute de dénominateur",
      (shown("Recherches sans résultat") ?? "").includes("non mesuré"));
check("aucun pourcentage affiché ne dépasse 100",
      [...html.matchAll(/([\d  ,.]+)\s*%/g)]
        .map((m) => Number(m[1].replace(/[  \s]/g, "").replace(",", ".")))
        .filter(Number.isFinite)
        .every((v) => v <= 100),
      [...html.matchAll(/([\d  ,.]+)\s*%/g)].map((m) => m[1]).join(" "));
check("la répartition du trafic par langue est présente",
      html.includes("Trafic par langue"));

// Nettoyage : les sessions ouvertes par le contrôle ne survivent pas au contrôle.
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [sessions]);
const { rows: [{ count: left }] } = await db.query(
  `SELECT count(*) FROM sessions WHERE token_hash = ANY($1)`, [sessions]);
check("les sessions du contrôle sont refermées", Number(left) === 0);

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
await db.end();
process.exit(fail ? 1 : 0);
