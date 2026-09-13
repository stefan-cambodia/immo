#!/usr/bin/env node
/**
 * Tient à jour la file de modération des prix invraisemblables (§6.1).
 *
 * La collecte reprend fidèlement ce que la source publie, erreurs de saisie
 * comprises. Ce job ne corrige rien : il range ce qui sort des bornes de sa
 * famille pour qu'un humain le regarde, et retire de la file ce dont le prix
 * est revenu dans les clous. Voir db/lib/price-review.mjs pour la règle et ce
 * qu'elle refuse de tester.
 *
 *   node db/jobs/review-prices.mjs [--dry-run] [--json]
 */
import pg from "pg";
import { reviewPrices, PRICE_FACTOR, MIN_FAMILY_SAMPLE } from "../lib/price-review.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const s = await reviewPrices(db, { dryRun: has("dry-run") });

if (has("json")) {
  console.log(JSON.stringify(s));
} else {
  console.log(`Familles : ${s.testable} testables sur ${s.families} `
    + `(facteur ${PRICE_FACTOR}, échantillon minimal ${MIN_FAMILY_SAMPLE})`);
  for (const skipped of s.skipped) console.log(`  hors test : ${skipped}`);
  console.log(`${s.queued} signalement(s) ouvert(s), ${s.closed} refermé(s) sans décision `
    + `— file : ${s.open}` + (s.dryRun ? " (simulation : rien n'a été écrit)" : ""));
}
await db.end();
