#!/usr/bin/env node
/**
 * Rattache les annonces collectées à leur programme immobilier.
 *
 * Le portail range les annonces d'un même immeuble neuf sous l'adresse du
 * programme. Cette adresse est déjà en base, dans `listings.source_url` : le
 * SLUG du programme ne demande donc aucune requête. Son NOM, lui, n'est que
 * sur la page — mais il appartient au programme, pas à l'annonce, si bien
 * qu'UNE page par programme suffit, et non une par annonce. C'est la
 * différence entre 72 requêtes et 3 232.
 *
 * Deux étages, dans cet ordre :
 *
 *   1. hors ligne — les programmes dont l'immeuble existe déjà au même slug
 *      sont rattachés sans toucher au réseau ;
 *   2. `--fetch` — pour les autres, une page est ouverte pour en lire le nom,
 *      l'immeuble est créé depuis ses propres unités, puis rattaché.
 *
 * Le rapprochement est EXACT (voir db/lib/buildings.mjs) : la source distingue
 * `urban-village-phase-1` de `urban-village-phase-2` et `the-peak-residences`
 * de `the-peak`.
 *
 *   node db/jobs/link-projects.mjs --dry-run          # ce qui serait fait, hors ligne
 *   node db/jobs/link-projects.mjs                    # étage 1 seul
 *   node db/jobs/link-projects.mjs --fetch --dry-run  # lit les pages, n'écrit rien
 *   node db/jobs/link-projects.mjs --fetch            # les deux étages
 */
import pg from "pg";
import { USER_AGENT, DEFAULT_DELAY_MS, fetchDetail } from "../lib/portal.mjs";
import { createFromProject, findByProjectSlug, knownProjects, linkProject, projectProperties }
  from "../lib/buildings.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const dryRun = flag("dry-run");
const doFetch = flag("fetch");
const min = Number(opt("min", "1"));
const delayMs = Number(opt("delay", String(DEFAULT_DELAY_MS)));
const limit = Number(opt("limit", "0"));

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const log = (...a) => console.log(...a);
const projects = await knownProjects(db);
const known = projects.filter((p) => p.buildingId);
const unknown = projects.filter((p) => !p.buildingId && p.listings >= min);

log(`${projects.length} programme(s) nommé(s) par les annonces collectées :`);
log(`  ${known.length} déjà en base, ${projects.length - known.length} inconnus`
  + (min > 1 ? ` dont ${unknown.length} d'au moins ${min} annonces` : ""));

// ------------------------------------------- étage 1 : les immeubles connus
let linked = 0, touched = 0;
for (const p of known) {
  const pending = await projectProperties(db, p.slug);
  if (!pending.length) continue;
  log(`  ${dryRun ? "·" : "+"} ${p.slug} → ${pending.length} bien(s)`);
  if (!dryRun) linked += await linkProject(db, { buildingId: p.buildingId, slug: p.slug });
  else linked += pending.length;
  touched++;
}
log(`Étage 1 : ${linked} bien(s) rattaché(s) à ${touched} immeuble(s) déjà en base`
  + (dryRun ? " (simulation)" : ""));

// ------------------------------------ étage 2 : les programmes à créer
if (doFetch) {
  const todo = limit > 0 ? unknown.slice(0, Math.floor(limit)) : unknown;
  log(`\nLecture d'UNE page par programme inconnu : ${todo.length} requête(s), `
    + `${delayMs} ms entre deux`);
  let created = 0, attached = 0, failed = 0, unnamed = 0;

  for (const [i, p] of todo.entries()) {
    try {
      const detail = await fetchDetail(p.sampleUrl);
      if (!detail) throw new Error("page illisible");
      const project = detail.project;
      if (!project) { unnamed++; log(`  ? ${p.slug} — la page ne nomme pas de programme`); continue; }
      if (project.slug !== p.slug) {
        // L'adresse de l'annonce et celle que l'en-tête donne doivent désigner
        // le même programme ; sinon on ne sait pas lequel des deux croire.
        failed++;
        log(`  ! ${p.slug} — l'en-tête annonce ${project.slug}`);
        continue;
      }
      if (dryRun) {
        const pending = await projectProperties(db, p.slug);
        log(`  · ${p.slug} « ${project.name} » — ${pending.length} bien(s)`);
      } else {
        await db.query("BEGIN");
        try {
          const existing = await findByProjectSlug(db, p.slug);
          const building = existing ?? await createFromProject(db, project);
          if (!building) throw new Error("aucune unité positionnée");
          if (!existing) created++;
          const n = await linkProject(db, { buildingId: building.id, slug: p.slug });
          attached += n;
          await db.query("COMMIT");
          log(`  + ${p.slug} « ${project.name} » → ${n} bien(s)`);
        } catch (e) { await db.query("ROLLBACK").catch(() => {}); throw e; }
      }
    } catch (e) {
      failed++;
      log(`  ! ${p.slug} — ${String(e.message).slice(0, 70)}`);
    }
    if (i + 1 < todo.length) await new Promise((r) => setTimeout(r, delayMs));
  }

  log(`\nÉtage 2 : ${created} immeuble(s) créé(s), ${attached} bien(s) rattaché(s), `
    + `${unnamed} sans programme nommé, ${failed} en échec` + (dryRun ? " (simulation)" : ""));
  log(`Les immeubles créés le sont à l'état « inconnu » : la source ne dit pas `
    + `où en est le chantier.`);
} else {
  log(`\n${unknown.length} programme(s) restent sans immeuble : leur nom n'est que sur la `
    + `page de la source. Relancer avec --fetch pour l'y lire (une requête par programme).`);
}

log(`\nAgent utilisateur : ${USER_AGENT}`);
await db.end();
