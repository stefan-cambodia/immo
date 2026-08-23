#!/usr/bin/env node
/**
 * Expiration des annonces à 45 jours (§6.3).
 *
 * C'est la mécanique qui tient la promesse de fraîcheur du portail : une
 * annonce que l'agent n'a pas reconfirmée disparaît, et la date de dernière
 * confirmation affichée publiquement reste vraie. Sans cette tâche, le portail
 * ressemble à ceux qu'il prétend remplacer — §1.2 : « les portails existants
 * conservent en ligne des annonces vendues depuis plus d'un an ».
 *
 * La bascule elle-même vit dans la base (`expire_stale_listings()`), pas ici :
 * la règle des 45 jours ne doit pas exister en deux exemplaires.
 *
 * Usage :
 *   node db/jobs/expire-listings.mjs [--dry-run] [--json]
 *
 * Cette tâche n'écrit pas dans le journal d'audit. Celui-ci trace les actions
 * de modération, c'est-à-dire des décisions humaines ; une expiration est
 * déterministe et entièrement reconstituable à partir de `expires_at` et de
 * `last_confirmed_at`, tous deux conservés. Y déverser des milliers de lignes
 * automatiques noierait ce qu'on y cherche.
 */
import pg from "pg";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const dryRun = flag("dry-run");
const asJson = flag("json");

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);
const emit = (payload) => {
  if (asJson) process.stdout.write(JSON.stringify(payload) + "\n");
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const result = { dryRun, due: 0, expired: 0, chaseWindow: 0, activeAfter: 0 };

const { rows: [due] } = await db.query(
  `SELECT count(*)::int AS n FROM listings
   WHERE status = 'active' AND expires_at < now()`);
result.due = due.n;

if (dryRun) {
  const { rows: byAgency } = await db.query(
    `SELECT a.name AS agency, count(*)::int AS n
     FROM listings l JOIN agencies a ON a.id = l.agency_id
     WHERE l.status = 'active' AND l.expires_at < now()
     GROUP BY a.name ORDER BY count(*) DESC LIMIT 10`);
  log(`À expirer : ${result.due}`);
  if (!asJson && byAgency.length) console.table(byAgency);
  result.byAgency = byAgency;
  log("--dry-run : aucune modification.");
} else {
  const { rows: [{ expire_stale_listings: expired }] } =
    await db.query(`SELECT expire_stale_listings()`);
  result.expired = expired;
  log(`Expirées : ${expired}`);
}

// Observation, pas action : le portail n'a pas encore de canal de relance
// automatique (le bot Telegram est en phase 2). Le back-office propose la
// relance à la main, et ce compteur dit combien de cas l'y attendent.
const { rows: [chase] } = await db.query(
  `SELECT count(*)::int AS n FROM listings
   WHERE status = 'active' AND expires_at BETWEEN now() AND now() + interval '7 days'`);
result.chaseWindow = chase.n;

const { rows: [active] } = await db.query(
  `SELECT count(*)::int AS n FROM listings WHERE status = 'active'`);
result.activeAfter = active.n;

log(`À relancer sous 7 jours : ${result.chaseWindow} · annonces actives : ${result.activeAfter}`);

emit(result);
await db.end();
