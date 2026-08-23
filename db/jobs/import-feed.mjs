#!/usr/bin/env node
/**
 * Import de flux XML / CSV pour les agences équipées d'un CRM (§6.1, canal 2).
 *
 * Le parseur ne fait que traduire un format en soumissions ; c'est l'entonnoir
 * commun (db/lib/ingest.mjs) qui décide où chaque annonce atterrit. Ajouter un
 * troisième format revient donc à écrire une fonction de lecture, pas une
 * seconde logique métier.
 *
 * Un point non négociable : une annonce qui n'apporte qu'une adresse texte
 * n'est PAS géocodée (principe n°2). Elle est enregistrée en `needs_pin` et
 * attend qu'un humain pose le pin. Des coordonnées explicites venues du CRM
 * sont acceptées : quelqu'un les y a posées.
 *
 *   node db/jobs/import-feed.mjs --file db/fixtures/ips-cambodia.xml --agency ips-cambodia
 *   node db/jobs/import-feed.mjs --file db/fixtures/century21.csv --agency century-21-mekong --dry-run
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import pg from "pg";
import { ingest } from "../lib/ingest.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const file = opt("file");
const agencySlug = opt("agency");
const dryRun = flag("dry-run");
const asJson = flag("json");

if (!file || !agencySlug) {
  console.error("Usage : --file <chemin> --agency <slug> [--dry-run] [--json]");
  process.exit(2);
}

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);

// ---------------------------------------------------------------- parseurs
/** XML sans dépendance : les flux d'agence sont plats et réguliers. */
function parseXml(text) {
  const out = [];
  for (const [, block] of text.matchAll(/<listing\b([^>]*)>([\s\S]*?)<\/listing>/g)) {
    out.push(block);
  }
  return [...text.matchAll(/<listing\b([^>]*)>([\s\S]*?)<\/listing>/g)].map(([, attrs, body]) => {
    const tag = (name) => {
      const m = body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? m[1].trim() : null;
    };
    const attr = (source, name) => {
      const m = source.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
      return m ? m[1] : null;
    };
    const geo = body.match(/<geo\b([^>]*)\/>/);
    const langMatch = body.match(/<description[^>]*lang="([^"]*)"/);
    return {
      externalRef: attr(attrs, "id"),
      type: tag("type"),
      transaction: tag("transaction"),
      priceUsd: Number(tag("price")),
      areaSqm: tag("area") ? Number(tag("area")) : null,
      landSqm: tag("land") ? Number(tag("land")) : null,
      bedrooms: Number(tag("bedrooms") ?? 0),
      bathrooms: Number(tag("bathrooms") ?? 0),
      floor: tag("floor") !== null ? Number(tag("floor")) : null,
      unit: tag("unit"),
      title: tag("title"),
      furnished: tag("furnished") === "true",
      areaName: tag("area_name"),
      building: tag("building"),
      lat: geo ? Number(attr(geo[1], "lat")) : null,
      lng: geo ? Number(attr(geo[1], "lng")) : null,
      description: tag("description"),
      lang: langMatch ? langMatch[1] : "en",
      photos: [...body.matchAll(/<photo>([^<]+)<\/photo>/g)].map((m) => m[1].trim()),
      address: tag("address"),
    };
  });
}

/** CSV avec guillemets ; suffisant pour les exports de CRM rencontrés. */
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((v) => v !== ""));
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const num = (v) => (v === "" || v === undefined ? null : Number(v));

  return body.map((r) => ({
    externalRef: r[idx.external_ref],
    type: r[idx.type],
    transaction: r[idx.transaction],
    priceUsd: Number(r[idx.price_usd]),
    areaSqm: num(r[idx.area_sqm]),
    landSqm: num(r[idx.land_sqm]),
    bedrooms: Number(r[idx.bedrooms] || 0),
    bathrooms: Number(r[idx.bathrooms] || 0),
    floor: num(r[idx.floor]),
    unit: null,
    title: r[idx.title],
    furnished: false,
    areaName: r[idx.area],
    building: r[idx.building] || null,
    lat: num(r[idx.lat]),
    lng: num(r[idx.lng]),
    description: r[idx.description],
    lang: r[idx.lang] || "en",
    photos: [],
    address: null,
  }));
}

// ------------------------------------------------------------------ import
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const { rows: agencyRows } = await db.query(
  `SELECT a.id, a.name,
          (SELECT ag.id FROM agents ag WHERE ag.agency_id = a.id ORDER BY ag.name LIMIT 1) AS agent_id
   FROM agencies a WHERE a.slug = $1`, [agencySlug]);
if (!agencyRows.length) {
  console.error(`Agence inconnue : ${agencySlug}`);
  process.exit(1);
}
const agency = agencyRows[0];

const text = await readFile(file, "utf8");
const source = extname(file).toLowerCase() === ".csv" ? "csv" : "xml_feed";
const records = source === "csv" ? parseCsv(text) : parseXml(text);

log(`Flux ${file} · agence ${agency.name} · ${records.length} annonces`);

const summary = { file, agency: agency.name, source, total: records.length,
                  accepted: 0, merged: 0, review: 0, created: 0,
                  needsPin: 0, duplicates: 0, failed: 0, details: [] };

for (const rec of records) {
  // Résolution du quartier via la table d'alias : c'est elle qui fait
  // atterrir « BKK1 », « Toul Tom Poung » ou « Sen Sok » sur la bonne localité.
  const { rows: loc } = await db.query(
    `WITH input AS (SELECT lower(unaccent($1)) AS q)
     SELECT l.id, l.slug,
            (SELECT max(GREATEST(similarity(lower(unaccent(term)), input.q),
                        CASE WHEN lower(unaccent(term)) = input.q THEN 1.0 ELSE 0 END))
             FROM unnest(l.aliases || ARRAY[l.slug]
                         || ARRAY(SELECT v FROM jsonb_each_text(l.name_i18n) AS e(k,v))) term,
                  input) AS score
     FROM locations l ORDER BY score DESC NULLS LAST LIMIT 1`,
    [rec.areaName ?? ""]);

  if (!loc.length || Number(loc[0].score) < 0.45) {
    summary.failed++;
    summary.details.push({ ref: rec.externalRef, outcome: "quartier introuvable", area: rec.areaName });
    continue;
  }

  const { rows: bld } = rec.building
    ? await db.query(
        `SELECT id FROM buildings
         WHERE lower(unaccent(name_i18n->>'en')) = lower(unaccent($1)) LIMIT 1`, [rec.building])
    : { rows: [] };

  const input = {
    source,
    agencyId: agency.id,
    agentId: agency.agent_id,
    externalRef: rec.externalRef,
    payload: rec,
    normalized: {
      propertyType: rec.type,
      locationId: loc[0].id,
      buildingId: bld.length ? bld[0].id : null,
      floor: rec.floor,
      unitNumber: rec.unit,
      bedrooms: rec.bedrooms,
      bathrooms: rec.bathrooms,
      indoorAreaSqm: rec.areaSqm,
      landAreaSqm: rec.landSqm,
      titleType: rec.title ?? "unknown",
      furnished: rec.furnished,
      transactionType: rec.transaction === "rent" ? "rent" : "sale",
      priceUsd: rec.priceUsd,
      description: rec.description,
      descriptionLang: rec.lang,
      // Adresse seule = pas de pin. Jamais de géocodage (principe n°2).
      lng: Number.isFinite(rec.lng) ? rec.lng : null,
      lat: Number.isFinite(rec.lat) ? rec.lat : null,
    },
    // Les empreintes seraient calculées au téléchargement des images ; le flux
    // d'exemple pointe vers un CDN fictif, elles restent donc nulles.
    photos: rec.photos.map((url) => ({ url, phash: null })),
  };

  try {
    await db.query("BEGIN");
    const outcome = await ingest(db, input);
    if (dryRun) await db.query("ROLLBACK"); else await db.query("COMMIT");

    if (outcome.status === "accepted") {
      summary.accepted++;
      if (outcome.decision === "merge") summary.merged++;
      else if (outcome.decision === "review") summary.review++;
      else summary.created++;
      summary.details.push({ ref: rec.externalRef, outcome: outcome.decision,
                             reference: outcome.reference, score: outcome.score,
                             reasons: outcome.reasons });
    } else if (outcome.status === "needs_pin") {
      summary.needsPin++;
      summary.details.push({ ref: rec.externalRef, outcome: "needs_pin",
                             raison: "aucune coordonnée fournie" });
    } else if (outcome.status === "duplicate_submission") {
      summary.duplicates++;
      summary.details.push({ ref: rec.externalRef, outcome: "déjà importée" });
    }
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    summary.failed++;
    summary.details.push({ ref: rec.externalRef, outcome: "échec", error: err.message });
  }
}

if (asJson) process.stdout.write(JSON.stringify(summary) + "\n");
else {
  console.table(summary.details);
  console.log(`Acceptées ${summary.accepted} (fusion ${summary.merged}, à valider ${summary.review}, nouvelles ${summary.created})`);
  console.log(`En attente de pin ${summary.needsPin} · déjà importées ${summary.duplicates} · échecs ${summary.failed}`);
  if (dryRun) console.log("--dry-run : toutes les transactions ont été annulées.");
}

await db.end();
process.exit(summary.failed > 0 ? 1 : 0);
