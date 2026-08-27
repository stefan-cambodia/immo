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

// --------------------------------------------------------- Instrumentation
console.log("Instrumentation (§10)");

const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json",
             "user-agent": "Mozilla/5.0 (Linux; Android 12) Chrome/141 Mobile Safari/537.36",
             ...headers },
  body: JSON.stringify(body),
});

const probeSession = "chk" + randomBytes(12).toString("hex");
const probeQuery = `contrôle-${randomBytes(4).toString("hex")}`;

const first = await post("/api/searches",
  { q: probeQuery, locale: "fr", resolved: false, session: probeSession });
const again = await post("/api/searches",
  { q: `  ${probeQuery.toUpperCase()}  `, locale: "fr", resolved: false, session: probeSession });
check("une recherche est comptée", first.status === 200 && (await first.json()).counted === true);
check("la même recherche affinée dans la journée ne compte pas deux fois",
      again.status === 200);

const { rows: [probe] } = await db.query(
  `SELECT count(*)::int AS n FROM search_events WHERE session_id = $1`, [probeSession]);
check("casse et espaces ne font pas deux recherches", probe.n === 1, `${probe.n} lignes`);

const { rows: [stored] } = await db.query(
  `SELECT query_hash FROM search_events WHERE session_id = $1`, [probeSession]);
check("le texte de la recherche n'est pas conservé",
      !stored.query_hash.includes("contrôle") && /^[0-9a-f]{32}$/.test(stored.query_hash),
      stored.query_hash);

const botSearch = await post("/api/searches",
  { q: probeQuery, locale: "fr", resolved: true, session: probeSession + "bot" },
  { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
check("un robot ne gonfle pas le dénominateur",
      (await botSearch.json()).counted === false);

// Le facteur de forme est déduit de l'agent utilisateur, jamais annoncé par
// le client : c'est lui qui sépare le p75 mobile du p75 de bureau.
const mobile = await post("/api/vitals", { metric: "lcp", value: 2400, locale: "fr", route: "search" });
const desktop = await post("/api/vitals", { metric: "lcp", value: 900, locale: "fr", route: "search" },
  { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/141 Safari/537.36" });
check("une mesure de LCP est acceptée", mobile.status === 200 && desktop.status === 200);

const { rows: [ff] } = await db.query(`
  SELECT count(*) FILTER (WHERE form_factor = 'mobile' AND value_ms = 2400)::int AS m,
         count(*) FILTER (WHERE form_factor = 'desktop' AND value_ms = 900)::int AS d
  FROM web_vitals WHERE created_at > now() - interval '2 minutes'`);
check("le facteur de forme vient de l'agent utilisateur, pas du client",
      ff.m >= 1 && ff.d >= 1, JSON.stringify(ff));

const absurd = await post("/api/vitals", { metric: "lcp", value: 999999, locale: "fr", route: "search" });
check("une mesure aberrante est refusée avant d'entrer en base", absurd.status === 400);
const unknown = await post("/api/vitals", { metric: "fcp", value: 1200, locale: "fr", route: "search" });
check("une métrique inconnue est refusée", unknown.status === 400);

// Nettoyage : le contrôle ne laisse pas ses propres mesures fausser un centile.
await db.query(`DELETE FROM search_events WHERE session_id LIKE 'chk%'`);
await db.query(`DELETE FROM web_vitals WHERE value_ms IN (2400, 900) AND route = 'search'
                  AND created_at > now() - interval '2 minutes'`);

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
// L'invariant, et non un état : aucune ligne ne doit rester nue. Une valeur
// sans cible ni mention explicite ne se lit pas — 71 %, mais par rapport à quoi ?
const ROWS = ["Biens actifs", "Annonces confirmées récemment",
              "Doublons résiduels (majorant)", "Recherches sans résultat",
              "Part via bot Telegram", "Contacts pour 1 000 sessions",
              "LCP p75 mobile"];
const bare = ROWS.filter((label) => {
  const row = shown(label) ?? "";
  return !["cible ≥", "cible ≤", "non mesuré", "à établir"].some((mark) => row.includes(mark));
});
check("chaque indicateur porte sa cible ou son absence de mesure",
      bare.length === 0, bare.join(", "));
check("les sept indicateurs du brief sont présents",
      ROWS.every((label) => html.includes(label)),
      ROWS.filter((label) => !html.includes(label)).join(", "));
// Les deux indicateurs instrumentés ne se vérifient pas par un état figé mais
// par leur RÈGLE : ils parlent quand la donnée est là, se taisent sinon.
const MIN_SAMPLE = 20;
const { rows: [m] } = await db.query(`
  SELECT (SELECT count(*) FROM web_vitals
           WHERE metric = 'lcp' AND form_factor = 'mobile'
             AND created_at > now() - interval '30 days')::int AS lcp,
         (SELECT count(*) FROM search_events
           WHERE created_at > now() - interval '30 days')::int AS searches`);

const lcpRow = shown("LCP p75 mobile") ?? "";
check(m.lcp >= MIN_SAMPLE
        ? `le LCP est publié (${m.lcp} mesures)`
        : `le LCP se tait sous le seuil d'échantillon (${m.lcp} mesures)`,
      m.lcp >= MIN_SAMPLE ? /\d\s*ms/.test(lcpRow) : lcpRow.includes("non mesuré"),
      lcpRow.slice(0, 120));

const missRow = shown("Recherches sans résultat") ?? "";
check(m.searches > 0
        ? `le taux d'échec est publié (${m.searches} recherches)`
        : "le taux d'échec se tait sans recherche mesurée",
      m.searches > 0 ? /%/.test(missRow) : missRow.includes("non mesuré"),
      missRow.slice(0, 120));
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
