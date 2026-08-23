#!/usr/bin/env node
/**
 * Traduction des descriptions en attente (§4.1).
 *
 * Pourquoi un worker et pas un appel dans la transaction d'ingestion : une
 * traduction prend plusieurs secondes. La faire à l'intérieur de la
 * transaction reviendrait à tenir un verrou de base ouvert pendant un appel
 * réseau, et à faire échouer la publication d'une annonce parce qu'une API est
 * indisponible. L'annonce est publiée immédiatement dans sa langue source ; la
 * traduction la rattrape.
 *
 * Cela reste « à l'ingestion » au sens du brief : une fois par annonce, pas à
 * chaque affichage.
 *
 *   node db/jobs/translate-listings.mjs [--limit N] [--retry] [--dry-run] [--json]
 */
import pg from "pg";
import { translateQueue } from "../lib/translate.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const dryRun = flag("dry-run");
const asJson = flag("json");
const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const summary = await translateQueue(db, {
  limit: Number(opt("limit", 20)),
  retry: flag("retry"),
  dryRun,
  onProgress: (p) => log(p.ok ? `  ✓ ${p.reference} (${p.sourceLang} → 4 langues)`
                              : `  ✗ ${p.reference} : ${p.error}`),
});

if (summary.skipped) log(`${summary.skipped} annonce(s) sans description écartée(s).`);
log(`À traduire : ${summary.queued}`);

if (dryRun && !asJson && summary.rows.length) {
  console.table(summary.rows.slice(0, 10).map((r) => ({
    reference: r.reference, source: r.source_lang, tier: r.tier,
    texte: String(r.description?.[r.source_lang] ?? "").slice(0, 48),
  })));
  log("--dry-run : aucune traduction effectuée.");
}

const { rows: [remaining] } = await db.query(`
  SELECT count(*) FILTER (WHERE translation_status = 'pending')::int AS pending,
         count(*) FILTER (WHERE translation_status = 'failed')::int AS failed,
         count(*) FILTER (WHERE translation_status = 'machine')::int AS machine,
         count(*) FILTER (WHERE translation_status = 'human_reviewed')::int AS reviewed
  FROM listings`);
summary.remaining = remaining;
delete summary.rows;

if (asJson) process.stdout.write(JSON.stringify(summary) + "\n");
else log(`Traduites ${summary.translated} · échecs ${summary.failed} · reste ${remaining.pending} en attente, ${remaining.failed} en échec`);

await db.end();
process.exit(summary.failed > 0 && !dryRun ? 1 : 0);
