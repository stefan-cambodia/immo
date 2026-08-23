#!/usr/bin/env node
/**
 * Vérifie la facturation et les quotas (§8) : application du quota à
 * l'ingestion, publication différée, mise en avant bornée dans le temps,
 * idempotence de la génération de factures.
 *
 * Le quota est ce que l'agence achète : s'il ne tient pas — une annonce de
 * trop qui passe, une retenue jamais publiée — l'abonnement ne vaut rien,
 * dans un sens ou dans l'autre.
 *
 * Tout se joue dans une transaction annulée à la fin : la base de
 * développement ressort intacte.
 *
 *   node db/checks/billing.mjs
 */
import pg from "pg";
import { ingest } from "../lib/ingest.mjs";
import { expireFeatured, generateInvoices, holdOrActive, issueInvoiceFor, releaseHeld }
  from "../lib/billing.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();
await db.query("BEGIN");

// ------------------------------------------------------------------ Paliers
console.log("Paliers");
const { rows: plans } = await db.query(
  `SELECT tier::text, price_usd_month::numeric AS price FROM plans ORDER BY price_usd_month`);
check("trois paliers définis", plans.length === 3, String(plans.length));
check("le palier gratuit est gratuit", plans.some((p) => p.tier === "free" && Number(p.price) === 0));

// ------------------------------------------------------ Décor de test
const { rows: [agency] } = await db.query(
  `INSERT INTO agencies(slug, name, subscription_tier, listing_quota, featured_quota)
   VALUES ('chk-billing', 'Agence de contrôle', 'standard', 1, 1) RETURNING id`);
const { rows: [agent] } = await db.query(
  `INSERT INTO agents(agency_id, name, phone) VALUES ($1, 'Contrôle', '+855 00 000 000')
   RETURNING id`, [agency.id]);
const { rows: [loc] } = await db.query(
  `SELECT id FROM locations WHERE level = 'neighborhood' LIMIT 1`);

const submission = (ref, over = {}) => ({
  source: "csv", agencyId: agency.id, agentId: agent.id, externalRef: ref,
  payload: {},
  normalized: {
    propertyType: "condo", locationId: loc.id, buildingId: null,
    floor: over.floor ?? 4, unitNumber: null,
    bedrooms: over.bedrooms ?? 2, bathrooms: 1,
    indoorAreaSqm: over.area ?? 70, landAreaSqm: null,
    titleType: "strata", yearBuilt: 2020, furnished: false,
    transactionType: "sale", priceUsd: over.price ?? 150000, negotiable: true,
    description: "", descriptionLang: "en",
    lng: 104.92 + (over.dx ?? 0), lat: 11.55,
  },
  photos: [],
});

// ------------------------------------------------------------------- Quota
console.log("Quota d'annonces actives");
const first = await ingest(db, submission("chk-1"));
check("la première annonce est publiée", first.status === "accepted" && !first.held,
      JSON.stringify({ status: first.status, held: first.held }));

// Un bien nettement différent, pour ne pas déclencher la déduplication.
const second = await ingest(db, submission("chk-2", { floor: 11, bedrooms: 4, area: 160, dx: 0.03 }));
check("la deuxième est retenue par le quota", second.status === "accepted" && second.held === true,
      JSON.stringify({ status: second.status, held: second.held }));

const { rows: [counts] } = await db.query(
  `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE status = 'pending')::int AS held
   FROM listings WHERE agency_id = $1`, [agency.id]);
check("1 active, 1 retenue en base", counts.active === 1 && counts.held === 1,
      JSON.stringify(counts));

// Un flux rejoué renvoie le même identifiant : rien ne doit s'empiler,
// ni en actif ni en retenu.
const replay = await ingest(db, submission("chk-1"));
const { rows: [afterReplay] } = await db.query(
  `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE status = 'pending')::int AS held
   FROM listings WHERE agency_id = $1`, [agency.id]);
check("un flux rejoué ne consomme pas de place",
      replay.status === "duplicate_submission" && afterReplay.active === 1 && afterReplay.held === 1,
      JSON.stringify({ status: replay.status, ...afterReplay }));

check("holdOrActive refuse la place suivante", (await holdOrActive(db, agency.id)) === "pending");

// -------------------------------------------------------- Publication différée
console.log("Publication différée");
await db.query(`UPDATE agencies SET listing_quota = 5 WHERE id = $1`, [agency.id]);
const released = await releaseHeld(db, agency.id);
check("la retenue est publiée quand le quota s'ouvre", released === 1, String(released));
const { rows: [after] } = await db.query(
  `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE status = 'pending')::int AS held
   FROM listings WHERE agency_id = $1`, [agency.id]);
check("plus aucune annonce retenue", after.active === 2 && after.held === 0,
      JSON.stringify(after));
check("releaseHeld est idempotent", (await releaseHeld(db, agency.id)) === 0);

// ------------------------------------------------------------- Mise en avant
console.log("Mise en avant");
let constrained = false;
try {
  await db.query("SAVEPOINT sp");
  await db.query(`UPDATE listings SET featured = true WHERE agency_id = $1
                  AND status = 'active' AND featured_until IS NULL`, [agency.id]);
} catch { constrained = true; await db.query("ROLLBACK TO sp"); }
check("pas de mise en avant sans échéance (contrainte)", constrained);

await db.query(
  `UPDATE listings SET featured = true, featured_until = now() - interval '1 day'
   WHERE id = $1`, [first.listingId]);
const expired = await expireFeatured(db);
check("l'échéance éteint la mise en avant", expired >= 1, String(expired));
const { rows: [feat] } = await db.query(
  `SELECT featured, featured_until IS NOT NULL AS trace FROM listings WHERE id = $1`,
  [first.listingId]);
check("l'échéance reste en trace après extinction", feat.featured === false && feat.trace,
      JSON.stringify(feat));

// ---------------------------------------------------------------- Factures
console.log("Factures");
const batch1 = await generateInvoices(db);
const mine1 = batch1.length;
check("la génération émet pour les paliers payants", mine1 >= 1, String(mine1));
const batch2 = await generateInvoices(db);
check("la génération est idempotente", batch2.length === 0, String(batch2.length));

const { rows: [inv] } = await db.query(
  `SELECT number, amount_usd::numeric AS amount, status::text, due_at > now() AS due_later
   FROM invoices WHERE agency_id = $1 AND period_start = date_trunc('month', now())::date
   AND status <> 'void'`, [agency.id]);
check("la facture porte le tarif du palier",
      inv && Number(inv.amount) === Number(plans.find((p) => p.tier === "standard").price),
      JSON.stringify(inv));
check("numérotation FAC-AAAA-NNNNN", /^FAC-\d{4}-\d{5}$/.test(inv?.number ?? ""), inv?.number);
check("émise, échéance à venir", inv?.status === "issued" && inv?.due_later === true);

// Une facture annulée peut être réémise pour la même période.
await db.query(`UPDATE invoices SET status = 'void' WHERE number = $1`, [inv.number]);
const reissued = await issueInvoiceFor(db, agency.id);
check("une période annulée peut être refacturée", reissued !== null && reissued.number !== inv.number,
      JSON.stringify(reissued));

const { rows: [freeAgency] } = await db.query(
  `INSERT INTO agencies(slug, name, subscription_tier, listing_quota)
   VALUES ('chk-billing-free', 'Agence gratuite', 'free', 20) RETURNING id`);
check("pas de facture pour le palier gratuit",
      (await issueInvoiceFor(db, freeAgency.id)) === null);

await db.query("ROLLBACK");
await db.end();

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
