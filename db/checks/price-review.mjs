#!/usr/bin/env node
/**
 * Vérifie la file de modération des prix invraisemblables (§6.1).
 *
 * Ce qui est en jeu : la collecte reprend fidèlement ce que la source publie,
 * erreurs de saisie comprises, et le tri « le moins cher d'abord » met le prix
 * faux en tête du catalogue. La file signale ; elle ne décide pas. Le contrôle
 * porte donc sur trois choses.
 *
 * 1. La règle refuse de tester ce qu'elle ne sait pas tester, et le dit :
 *    une famille trop petite, ou dont l'étendue propre dépasse déjà le facteur
 *    de signalement — le terrain, dont une parcelle de province et un terrain
 *    commercial diffèrent légitimement d'un facteur 72.
 * 2. La file se vide dans les deux sens : par décision, mais aussi toute seule
 *    quand un prix revient dans les clous. Une file qui ne se vide que par
 *    décision se remplit de questions périmées.
 * 3. Une décision est tracée, et « prix faux » retire l'annonce du catalogue.
 *
 *   node db/checks/price-review.mjs
 */
import pg from "pg";
import { randomBytes, createHash } from "node:crypto";
import { priceFamilies, priceVerdict, reviewPrices, PRICE_FACTOR, MIN_FAMILY_SAMPLE }
  from "../lib/price-review.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

// ------------------------------------------------------------ Le verdict
console.log("Verdict sur un prix");
const testable = { median: 100000, testable: true };
check("un prix dans les clous ne dit rien",
      priceVerdict(150000, testable) === null);
check(`${PRICE_FACTOR} fois la médiane est signalé`,
      priceVerdict(100000 * PRICE_FACTOR + 1, testable)?.reasons.length === 1);
check(`un ${PRICE_FACTOR}ᵉ de la médiane aussi`,
      priceVerdict(100000 / PRICE_FACTOR - 1, testable)?.reasons.length === 1);
check("juste sous le facteur, rien n'est signalé",
      priceVerdict(100000 * (PRICE_FACTOR - 1), testable) === null
        && priceVerdict(100000 / (PRICE_FACTOR - 1), testable) === null);
// Une famille non testable ne signale rien, plutôt que de signaler au hasard.
check("une famille non testable ne produit aucun verdict",
      priceVerdict(1, { median: 100000, testable: false }) === null
        && priceVerdict(1, undefined) === null);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

// ----------------------------------------------------------- Les familles
console.log("\nFamilles de prix");
const families = await priceFamilies(db);
check("les familles sont formées par type et transaction", families.length > 0,
      String(families.length));
check("chaque famille non testable dit pourquoi",
      families.every((f) => f.testable || (typeof f.skipped === "string" && f.skipped.length > 0)),
      families.filter((f) => !f.testable && !f.skipped).map((f) => f.type).join(", "));
check(`une famille sous ${MIN_FAMILY_SAMPLE} annonces n'est pas testée`,
      families.filter((f) => f.n < MIN_FAMILY_SAMPLE).every((f) => !f.testable),
      families.filter((f) => f.n < MIN_FAMILY_SAMPLE && f.testable).map((f) => f.type).join(", "));
// Le terrain : une parcelle de province et un terrain commercial de Phnom Penh
// diffèrent légitimement d'un facteur bien supérieur à celui du signalement.
check("une famille plus étendue que le facteur n'est pas testée",
      families.filter((f) => f.spread > PRICE_FACTOR).every((f) => !f.testable),
      families.filter((f) => f.spread > PRICE_FACTOR && f.testable).map((f) => f.type).join(", "));

// -------------------------------------------------------------- La file
console.log("\nTenue de la file");
await db.query("BEGIN");
const { rows: [victim] } = await db.query(`
  SELECT l.id, l.price_usd AS price, p.property_type::text AS type,
         l.transaction_type::text AS transaction
  FROM listings l JOIN properties p ON p.id = l.property_id
  WHERE l.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM price_reviews r WHERE r.listing_id = l.id)
  ORDER BY p.reference LIMIT 1`);
const family = families.find((f) => f.type === victim.type && f.transaction === victim.transaction);
check("le jeu fournit une annonce d'une famille testable", Boolean(family?.testable),
      `${victim?.type}/${victim?.transaction}`);

if (family?.testable) {
  const absurde = Math.round(family.median * PRICE_FACTOR * 3);
  await db.query(`UPDATE listings SET price_usd = $2 WHERE id = $1`, [victim.id, absurde]);
  const s1 = await reviewPrices(db);
  const open = async () => (await db.query(
    `SELECT id, ratio FROM price_reviews WHERE listing_id = $1 AND reviewed_at IS NULL`,
    [victim.id])).rows[0];
  check("un prix absurde entre en file", Boolean(await open()), JSON.stringify(s1));

  // Deux passages ne doivent pas produire deux signalements du même cas.
  await reviewPrices(db);
  const { rows: doublons } = await db.query(
    `SELECT count(*)::int n FROM price_reviews WHERE listing_id = $1 AND reviewed_at IS NULL`,
    [victim.id]);
  check("un second passage n'ouvre pas un doublon", doublons[0].n === 1, String(doublons[0].n));

  // Le prix revient dans les clous : la file se vide sans qu'on tranche.
  await db.query(`UPDATE listings SET price_usd = $2 WHERE id = $1`, [victim.id, victim.price]);
  const s2 = await reviewPrices(db);
  check("un prix revenu dans les clous sort de la file sans décision",
        !(await open()) && s2.closed >= 1, JSON.stringify(s2));

  // Un cas tranché ne revient pas tant que le prix ne bouge pas.
  await db.query(`UPDATE listings SET price_usd = $2 WHERE id = $1`, [victim.id, absurde]);
  await reviewPrices(db);
  const { id: reviewId } = await open();
  await db.query(
    `UPDATE price_reviews SET reviewed_at = now(), decision = 'sound' WHERE id = $1`, [reviewId]);
  await reviewPrices(db);
  check("un cas tranché ne revient pas au même prix", !(await open()));
  await db.query(`UPDATE listings SET price_usd = $2 WHERE id = $1`, [victim.id, absurde * 2]);
  await reviewPrices(db);
  check("… mais revient si le prix a changé", Boolean(await open()));
}

// La simulation ne doit rien écrire.
const avant = (await db.query(`SELECT count(*)::int n FROM price_reviews`)).rows[0].n;
await reviewPrices(db, { dryRun: true });
const apres = (await db.query(`SELECT count(*)::int n FROM price_reviews`)).rows[0].n;
check("la simulation ne touche pas la file", avant === apres, `${avant} → ${apres}`);
await db.query("ROLLBACK");

// -------------------------------------------------------- Garde-fous SQL
console.log("\nContraintes");
await db.query("BEGIN");
const refuse = async (sql, params) => {
  try { await db.query(sql, params); return false; }
  catch { return true; } finally { await db.query("ROLLBACK TO SAVEPOINT s").catch(() => {}); }
};
await db.query("SAVEPOINT s");
const { rows: [any] } = await db.query(`SELECT id FROM listings LIMIT 1`);
check("une décision inconnue est refusée",
      await refuse(`INSERT INTO price_reviews(listing_id, price_usd, median_usd, ratio,
                      reviewed_at, decision) VALUES ($1, 1, 1, 1, now(), 'peut-etre')`, [any.id]));
check("une décision sans date d'examen est refusée",
      await refuse(`INSERT INTO price_reviews(listing_id, price_usd, median_usd, ratio, decision)
                    VALUES ($1, 1, 1, 1, 'sound')`, [any.id]));
check("une date d'examen sans décision est refusée",
      await refuse(`INSERT INTO price_reviews(listing_id, price_usd, median_usd, ratio, reviewed_at)
                    VALUES ($1, 1, 1, 1, now())`, [any.id]));
await db.query("ROLLBACK");

// ------------------------------------------------------------- Le panneau
// La file n'a de valeur que si un modérateur la voit, avec de quoi trancher :
// le prix, sa référence, et le lien vers l'annonce d'origine — c'est là qu'on
// lit si l'annonceur s'est trompé de case.
console.log("\nPanneau de modération");
let serverUp = true;
try { await fetch(`${BASE}/api/health`); } catch { serverUp = false; }
if (!serverUp) {
  check(`serveur joignable sur ${BASE}`, false, "lancez le service ou `npm run dev -- -p 3111`");
} else {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at)
     SELECT $1, id, now() + interval '1 hour' FROM users WHERE role = 'admin' AND active LIMIT 1`,
    [createHash("sha256").update(token).digest("hex")]);
  const html = await (await fetch(`${BASE}/fr/backoffice`,
    { headers: { cookie: `bo_session=${token}` } })).text();
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`,
    [createHash("sha256").update(token).digest("hex")]);

  const { rows: queue } = await db.query(`
    SELECT p.reference, l.source_url AS url FROM price_reviews r
    JOIN listings l ON l.id = r.listing_id JOIN properties p ON p.id = l.property_id
    WHERE r.reviewed_at IS NULL
    ORDER BY greatest(r.ratio, 1 / nullif(r.ratio, 0)) DESC LIMIT 8`);
  check("le panneau porte le titre de la file", html.includes("Prix invraisemblables"));
  check(`les ${queue.length} cas en tête de file y figurent`,
        queue.every((r) => html.includes(r.reference)),
        queue.filter((r) => !html.includes(r.reference)).map((r) => r.reference).join(", "));
  check("chacun renvoie à l'annonce d'origine, seule façon de trancher",
        queue.filter((r) => r.url).every((r) => html.includes(r.url)),
        queue.filter((r) => r.url && !html.includes(r.url)).length + " manquant(s)");
  check("les deux issues sont proposées",
        html.includes("Prix correct") && html.includes("Prix faux"));
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
