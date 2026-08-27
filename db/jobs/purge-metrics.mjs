#!/usr/bin/env node
/**
 * Purge des mesures de terrain au-delà de la fenêtre d'observation (§10).
 *
 * `search_events` et `web_vitals` ne sont pas des archives : ce sont des
 * mesures, lues sur une fenêtre glissante de trente jours par le panneau de
 * santé du back-office. Rien ne les relit au-delà.
 *
 * Les garder indéfiniment serait doublement mauvais. Techniquement, deux
 * tables qui grossissent à chaque recherche et à chaque page vue finissent par
 * peser sur la base sans que personne n'en tire quoi que ce soit. Et sur le
 * fond : un identifiant de session, même opaque, reste un identifiant — le
 * conserver des années après que la mesure a servi est exactement ce que le
 * portail s'interdit ailleurs (§ vie privée de `property_views`).
 *
 * La rétention par défaut est le double de la fenêtre d'observation : de quoi
 * comparer une période à la précédente, pas davantage.
 *
 *   node db/jobs/purge-metrics.mjs [--days 60] [--dry-run] [--json]
 */
import pg from "pg";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const days = Number(opt("days", "60"));
const dryRun = flag("dry-run");
const asJson = flag("json");

if (!Number.isFinite(days) || days < 1) {
  console.error("--days attend un nombre de jours positif");
  process.exit(2);
}

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const TABLES = ["search_events", "web_vitals"];
const summary = { days, dryRun, purged: {}, remaining: {} };

await db.query("BEGIN");
for (const table of TABLES) {
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE created_at < now() - make_interval(days => $1::int)`,
    [days]);
  summary.purged[table] = n;
  if (!dryRun && n > 0) {
    await db.query(
      `DELETE FROM ${table} WHERE created_at < now() - make_interval(days => $1::int)`, [days]);
  }
  const { rows: [{ n: left }] } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
  summary.remaining[table] = left;
}
if (dryRun) await db.query("ROLLBACK"); else await db.query("COMMIT");

const total = Object.values(summary.purged).reduce((a, b) => a + b, 0);
// Le lanceur ne sait lire qu'une clé de premier niveau : on la lui donne.
summary.purgedSearchEvents = summary.purged.search_events;
summary.purgedWebVitals = summary.purged.web_vitals;
summary.purgedTotal = total;
if (asJson) console.log(JSON.stringify(summary));
else {
  console.log(dryRun
    ? `${total} mesure(s) seraient purgées au-delà de ${days} j.`
    : `${total} mesure(s) purgées au-delà de ${days} j.`);
  for (const t of TABLES) console.log(`  ${t} : ${summary.purged[t]} retirée(s), ${summary.remaining[t]} restante(s)`);
}

await db.end();
