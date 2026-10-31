#!/usr/bin/env node
/**
 * « Toujours disponible ? » pour les annonces collectées (§6.3).
 *
 * Une annonce saisie par une agence se reconfirme quand l'agent répond à la
 * relance J-7 (`send-reminders.mjs`). Une annonce collectée n'a pas d'agent à
 * relancer : la question se pose à sa page chez la source, et c'est ce que fait
 * cette tâche, à la même échéance — pour chaque annonce active qui entre dans
 * sa dernière semaine.
 *
 * Sans elle, la collecte laissait une impasse : une collecte rejouée tombe sur
 * une référence connue et s'arrête (« déjà importée »), si bien qu'aucune
 * annonce collectée n'était jamais reconduite. Constat du 30/10/2026 : les
 * 3 405 annonces de la base réelle avaient toutes passé leurs 45 jours, encore
 * publiées. Faire tourner l'expiration n'aurait pas mieux valu — elle aurait
 * retiré le catalogue entier, y compris les annonces toujours en ligne.
 *
 * Ce que la page répond, et ce qu'on en fait :
 *   - toujours proposée (`current`)  → reconduite 45 jours, au prix affiché ;
 *   - vendue ou louée                 → `sold` ;
 *   - disparue (404/410)              → `expired` sur-le-champ ;
 *   - autre chose, ou rien de lisible → rien. L'expiration tranchera si le
 *     doute dure jusqu'au bout, comme pour un agent qui ne répond pas.
 * Seules les deux certitudes agissent ; la tâche ne devine jamais.
 *
 * La source garde en ligne les annonces vendues ou louées : une page qui
 * répond n'est donc pas une annonce disponible, et c'est l'état publié dans
 * la page qui fait foi (voir `availabilityVerdict`).
 *
 * Comme l'expiration, cette tâche n'écrit pas dans le journal d'audit, qui
 * trace des décisions humaines. Ce qu'elle a observé reste sur l'annonce :
 * `source_checked_at` et `source_state` (migration 029).
 *
 *   node db/jobs/reconfirm-portal.mjs [--dry-run] [--json] [--limit N]
 *        [--window JOURS] [--delay MS] [--concurrency N]
 *
 * `--dry-run` lit les pages mais n'écrit rien ; il se borne à dix annonces
 * sauf `--limit` — une simulation n'a pas à coûter un cycle de requêtes à la
 * source. Reprenable par construction : une annonce reconduite sort de la
 * fenêtre, une interruption ne coûte que le temps passé.
 */
import pg from "pg";
import { fetchAvailability, DEFAULT_DELAY_MS } from "../lib/portal.mjs";
import { refreshLocationCounts } from "../lib/locations.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const dryRun = flag("dry-run");
const asJson = flag("json");
// La fenêtre de la relance J-7 des agents : même échéance, même délai pour
// qu'un doute passager (page illisible, source en panne) ait le temps d'être
// levé par une relance suivante avant que l'expiration ne tranche.
const windowDays = Number(opt("window", "7"));
const limit = Number(opt("limit", dryRun ? "10" : "0"));
const delayMs = Number(opt("delay", String(DEFAULT_DELAY_MS)));
const concurrency = Math.max(1, Number(opt("concurrency", "2")));
// Au-delà, la source refuse ou ne répond plus : insister ne ferait que
// marteler un serveur qui a dit non. On s'arrête, et la relance suivante
// reprendra où l'on en était.
const MAX_FAILURES_IN_A_ROW = 8;

if (!Number.isFinite(windowDays) || windowDays < 0) {
  console.error("--window attend un nombre de jours");
  process.exit(2);
}

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const WHERE = `l.status = 'active' AND l.source = 'portal' AND l.source_url IS NOT NULL
               AND l.expires_at < now() + make_interval(days => $1)`;

const { rows: [{ n: due }] } = await db.query(
  `SELECT count(*)::int AS n FROM listings l WHERE ${WHERE}`, [windowDays]);

// Les plus pressées d'abord : si la source coupe en route, ce qu'on a pu lire
// est ce qui allait expirer le plus tôt.
const { rows: todo } = await db.query(
  `SELECT l.id, l.transaction_type::text AS txn, l.price_usd AS "priceUsd",
          l.source_url AS "sourceUrl",
          COALESCE(p.land_area_sqm, p.indoor_area_sqm) AS "areaSqm"
     FROM listings l JOIN properties p ON p.id = l.property_id
    WHERE ${WHERE}
    ORDER BY l.expires_at, l.id
    ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ""}`, [windowDays]);

const summary = {
  dryRun, window: windowDays, due, checked: 0,
  confirmed: 0, repriced: 0, concluded: 0, withdrawn: 0, unclear: 0, unreadable: 0,
  aborted: false, states: {}, reasons: {}, locationsRefreshed: 0,
};
const count = (bag, k) => { bag[k] = (bag[k] ?? 0) + 1; };

log(`Annonces collectées à relire : ${due} dans les ${windowDays} jour(s)`
  + (todo.length < due ? `, ${todo.length} cette fois` : "")
  + ` — ${concurrency} en parallèle, ${delayMs} ms entre deux requêtes par fil`);

/** Écrit ce que la page a répondu. Une seule instruction : pas de transaction. */
async function record(item, a) {
  if (dryRun) return;
  switch (a.verdict) {
    case "confirmed":
      await db.query(
        `UPDATE listings
            SET last_confirmed_at = now(), expires_at = now() + interval '45 days',
                price_usd = COALESCE($2, price_usd),
                source_checked_at = now(), source_state = $3, updated_at = now()
          WHERE id = $1 AND status = 'active'`, [item.id, a.priceUsd, a.state]);
      break;
    case "concluded":
      await db.query(
        `UPDATE listings
            SET status = 'sold', source_checked_at = now(), source_state = $2, updated_at = now()
          WHERE id = $1 AND status = 'active'`, [item.id, a.state]);
      break;
    case "withdrawn":
      await db.query(
        `UPDATE listings
            SET status = 'expired', expires_at = LEAST(expires_at, now()),
                source_checked_at = now(), source_state = 'withdrawn', updated_at = now()
          WHERE id = $1 AND status = 'active'`, [item.id]);
      break;
    case "unclear":
      // Rien ne change pour l'annonce ; on garde seulement la trace de ce qui
      // a été lu, pour que l'état inattendu se compte et se retrouve.
      await db.query(
        `UPDATE listings SET source_checked_at = now(), source_state = $2
          WHERE id = $1 AND status = 'active'`, [item.id, a.state ?? "unknown"]);
      break;
    // `unreadable` : rien n'est écrit, la relance suivante reposera la question.
  }
}

const queue = todo.slice();
let failuresInARow = 0;

const worker = async () => {
  while (queue.length && !summary.aborted) {
    const item = queue.shift();
    let a;
    try {
      a = await fetchAvailability(item.sourceUrl, {
        transaction: item.txn,
        areaSqm: item.areaSqm === null ? null : Number(item.areaSqm),
      });
    } catch (e) {
      a = { verdict: "unreadable", reason: `réseau : ${String(e.cause?.code ?? e.message).slice(0, 60)}` };
    }

    summary.checked++;
    count(summary.states, a.state ?? (a.verdict === "unreadable" ? "(illisible)" : "(sans état)"));
    summary[a.verdict]++;
    if (a.verdict === "unreadable") count(summary.reasons, a.reason);
    if (a.verdict === "unclear") {
      count(summary.reasons, a.state === "current"
        ? `transaction changée : ${a.listingType}` : `état non reconnu : ${a.state ?? "absent"}`);
    }
    if (a.verdict === "confirmed" && a.priceUsd !== null && a.priceUsd !== Number(item.priceUsd)) {
      summary.repriced++;
    }

    // Seul un refus ou un silence de la source compte comme une panne. Une page
    // lue, quel qu'en soit le verdict, prouve que la source répond.
    if (a.verdict === "unreadable" && a.reason !== "page sans annonce") {
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        summary.aborted = true;
        log(`  ${failuresInARow} échecs d'affilée (${a.reason}) : arrêt, la relance suivante reprendra.`);
      }
    } else {
      failuresInARow = 0;
    }

    try {
      await record(item, a);
    } catch (e) {
      count(summary.reasons, `écriture : ${String(e.message).slice(0, 60)}`);
    }

    if (summary.checked % 100 === 0) {
      log(`  ${summary.checked}/${todo.length} · ${summary.confirmed} reconduite(s), `
        + `${summary.concluded} conclue(s), ${summary.withdrawn} disparue(s)`);
    }
    if (queue.length && !summary.aborted) await new Promise((r) => setTimeout(r, delayMs));
  }
};

await Promise.all(Array.from({ length: concurrency }, worker));

// Une annonce retirée fait baisser le compteur de sa localité — lu par la page
// d'accueil et la boîte de recherche. Sur la machine de démonstration,
// l'expiration horaire qui s'en charge d'ordinaire peut ne pas tourner.
if (!dryRun && summary.concluded + summary.withdrawn > 0) {
  summary.locationsRefreshed = await refreshLocationCounts(db);
}

log("");
log(`Relu    : ${summary.checked} page(s) sur ${due} annonce(s) dans la fenêtre`);
log(`Verdict : ${summary.confirmed} reconduite(s) dont ${summary.repriced} à un nouveau prix · `
  + `${summary.concluded} vendue(s) ou louée(s) · ${summary.withdrawn} disparue(s) · `
  + `${summary.unclear} douteuse(s) · ${summary.unreadable} illisible(s)`);
log(`États   : ${Object.entries(summary.states).map(([k, n]) => `${k} ${n}`).join(", ") || "—"}`);
for (const [reason, n] of Object.entries(summary.reasons)) log(`          · ${reason} : ${n}`);
if (summary.locationsRefreshed) log(`Compteurs de localité recalculés : ${summary.locationsRefreshed}`);
if (dryRun) log("(simulation : rien n'a été écrit)");
if (asJson) console.log(JSON.stringify(summary));

await db.end();
process.exit(summary.aborted ? 1 : 0);
