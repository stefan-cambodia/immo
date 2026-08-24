#!/usr/bin/env node
/**
 * Vérifie la vérification documentaire des titres (phase 4).
 *
 * Le badge « titre vérifié » engage la confiance des visiteurs : il ne vaut
 * que si la machine à états est étanche — un seul dossier ouvert par bien,
 * pas de confirmation sans documents, une conclusion qui corrige le bien
 * (et recalcule l'éligibilité étranger), la plus récente faisant foi.
 *
 * La partie base tourne dans une transaction annulée à la fin ; la partie
 * publique lit les données du seed sur le serveur de développement.
 *
 *   node db/checks/title-verification.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import { advanceVerification, concludeVerification, openVerification }
  from "../lib/titles.mjs";

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
await db.query("BEGIN");

// ------------------------------------------------------ Décor de test
// Un bien au titre déclaré « unknown », 3e étage : non éligible étranger
// tant que le titre n'est pas établi.
const { rows: [loc] } = await db.query(
  `SELECT id FROM locations WHERE level = 'neighborhood' LIMIT 1`);
const { rows: [property] } = await db.query(
  `INSERT INTO properties(reference, property_type, location_id, geo_point,
     floor, bedrooms, bathrooms, indoor_area_sqm, title_type, dedup_signature)
   VALUES ('CHK-TITLE1', 'condo', $1, ST_SetSRID(ST_MakePoint(104.92, 11.55), 4326),
           3, 2, 1, 80, 'unknown', 'chk-title-1')
   RETURNING id, foreign_eligible AS eligible`, [loc.id]);
check("le bien de départ n'est pas éligible étranger", property.eligible === false);

const { rows: [partner] } = await db.query(
  `INSERT INTO verification_partners(slug, name, contact)
   VALUES ('chk-partner', 'Cabinet de contrôle', 'chk@example.org') RETURNING id, name`);

// ------------------------------------------------------ Machine à états
console.log("Machine à états");
const open = { propertyId: property.id, partnerId: partner.id, requestedBy: "chk@khmerestate.kh" };
const dossier = await openVerification(db, open);
check("un dossier s'ouvre avec instantanés",
      dossier?.status === "requested" && dossier?.reference === "CHK-TITLE1"
        && dossier?.partner === partner.name && dossier?.claimedTitle === "unknown",
      JSON.stringify(dossier));

check("pas de second dossier ouvert sur le même bien",
      (await openVerification(db, open)) === "already_open");

check("pas de saut d'étape (demandé → en examen)",
      (await advanceVerification(db, dossier.id, "in_review")) === null);
check("pas de confirmation sans documents",
      (await concludeVerification(db, dossier.id,
        { outcome: "confirmed", confirmedTitle: "strata" })) === null);

const received = await advanceVerification(db, dossier.id, "documents_received");
check("documents reçus, datés", received?.status === "documents_received");
const reviewing = await advanceVerification(db, dossier.id, "in_review");
check("passage en examen", reviewing?.status === "in_review");

// ------------------------------------------------------ Conclusion
console.log("Conclusion");
const concluded = await concludeVerification(db, dossier.id, {
  outcome: "confirmed", confirmedTitle: "strata", note: "Strata inscrit au registre." });
check("la confirmation garde le titre déclaré ET le titre établi",
      concluded?.verification.confirmedTitle === "strata" && concluded?.previousTitle === "unknown",
      JSON.stringify(concluded));

const { rows: [after] } = await db.query(
  `SELECT title_type::text AS title, foreign_eligible AS eligible,
          title_verified_at IS NOT NULL AS badged, title_verified_by AS by
   FROM properties WHERE id = $1`, [property.id]);
check("le bien est corrigé avec le titre établi", after.title === "strata", after.title);
check("l'éligibilité étranger se recalcule (strata, 3e étage)", after.eligible === true);
check("le badge public est daté et signé du partenaire",
      after.badged === true && after.by === partner.name, JSON.stringify(after));

check("une conclusion est définitive",
      (await concludeVerification(db, dossier.id, { outcome: "rejected" })) === null);

// Un nouvel examen peut s'ouvrir après conclusion ; son rejet retire le badge
// (la conclusion la plus récente fait foi) sans toucher au titre établi.
const second = await openVerification(db, open);
check("un nouveau dossier peut s'ouvrir après conclusion", second?.status === "requested");
const rejected = await concludeVerification(db, second.id,
  { outcome: "rejected", note: "Documents jamais fournis." });
check("le rejet est possible dès le stade demandé", rejected?.verification.status === "rejected");
const { rows: [final] } = await db.query(
  `SELECT title_type::text AS title, title_verified_at IS NULL AS unbadged
   FROM properties WHERE id = $1`, [property.id]);
check("le rejet retire le badge sans toucher au titre",
      final.unbadged === true && final.title === "strata", JSON.stringify(final));

await db.query("ROLLBACK");

// ------------------------------------------------------ Fiche publique
console.log("\nFiche publique");
const { rows: [seeded] } = await db.query(
  `SELECT property_reference AS ref, partner_name AS partner
   FROM title_verifications WHERE status = 'confirmed' LIMIT 1`);
check("le seed fournit un dossier confirmé", Boolean(seeded), "lancer npm run db:seed");
if (seeded) {
  const html = await (await fetch(`${BASE}/en/property/${seeded.ref}`)).text();
  check("le badge « titre vérifié » est sur la fiche", html.includes("Verified title"), seeded.ref);
  check("le partenaire est nommé publiquement", html.includes(seeded.partner), seeded.partner);
  check("la réserve « pas un avis juridique » accompagne le badge",
        html.includes("it is not legal advice"), "");
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
