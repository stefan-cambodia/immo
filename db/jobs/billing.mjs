#!/usr/bin/env node
/**
 * Cycle de facturation et de quotas (phase 3 — §8).
 *
 * À chaque passage, dans cet ordre :
 *   1. extinction des mises en avant arrivées à échéance ;
 *   2. émission des factures du mois pour les paliers payants (idempotent :
 *      l'index partiel écarte les périodes déjà facturées) ;
 *   3. publication des annonces retenues des agences où une place s'est
 *      libérée (expirations de la nuit, extinctions de l'étape 1) ;
 *   4. inventaire des factures en retard, pour le journal et la relance.
 *
 * Tout l'état vit dans la base : le job peut tourner tous les jours, être
 * relancé après un échec, ou rattraper des jours manqués sans rien dupliquer.
 *
 *   node db/jobs/billing.mjs [--dry-run] [--json]
 *
 * Variables : DATABASE_URL.
 */
import pg from "pg";
import { expireFeatured, generateInvoices, overdueInvoices, releaseHeld }
  from "../lib/billing.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const dryRun = flag("dry-run");
const asJson = flag("json");

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const result = { dryRun, featuredExpired: 0, invoices: 0, amountUsd: 0,
                 released: 0, overdue: 0 };

if (dryRun) {
  // La simulation lit ce que chaque étape TOUCHERAIT, sans rien écrire.
  const { rows: [f] } = await db.query(
    `SELECT count(*)::int AS n FROM listings WHERE featured AND featured_until < now()`);
  result.featuredExpired = f.n;

  const { rows: [inv] } = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(p.price_usd_month), 0)::numeric AS total
     FROM agencies a JOIN plans p ON p.tier = a.subscription_tier
     WHERE p.price_usd_month > 0
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.agency_id = a.id
             AND i.period_start = date_trunc('month', now())::date
             AND i.status <> 'void')`);
  result.invoices = inv.n;
  result.amountUsd = Number(inv.total);

  const { rows: [held] } = await db.query(
    `SELECT count(*)::int AS n FROM listings WHERE status = 'pending'`);
  log(`--dry-run : ${result.featuredExpired} mise(s) en avant à éteindre, ` +
      `${result.invoices} facture(s) à émettre (${result.amountUsd} $), ` +
      `${held.n} annonce(s) retenue(s) candidates à la publication.`);
} else {
  await db.query("BEGIN");
  try {
    result.featuredExpired = await expireFeatured(db);

    const issued = await generateInvoices(db);
    result.invoices = issued.length;
    result.amountUsd = issued.reduce((a, i) => a + Number(i.amountUsd), 0);
    for (const i of issued) log(`  facture ${i.number} — ${i.agencyName} — ${i.amountUsd} $`);

    // Les places libérées depuis le dernier passage (annonces expirées par le
    // job d'expiration, quotas relevés) profitent aux annonces retenues.
    const { rows: heldAgencies } = await db.query(
      `SELECT DISTINCT agency_id FROM listings WHERE status = 'pending'`);
    for (const { agency_id } of heldAgencies) {
      result.released += await releaseHeld(db, agency_id);
    }

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

const overdue = await overdueInvoices(db);
result.overdue = overdue.length;
for (const o of overdue) {
  log(`  RETARD ${o.number} — ${o.agencyName} — ${o.amountUsd} $ — ${o.daysLate} j`);
}

log(`Terminé : ${result.featuredExpired} extinction(s), ${result.invoices} facture(s), ` +
    `${result.released} publication(s) différée(s), ${result.overdue} retard(s).`);
if (asJson) process.stdout.write(JSON.stringify(result) + "\n");

await db.end();
