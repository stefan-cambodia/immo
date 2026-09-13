#!/usr/bin/env node
/**
 * Traitement des médias en attente : variantes WebP/AVIF/JPEG générées et
 * stockées, empreinte perceptuelle calculée si absente (§6.2, §7).
 *
 *   node db/jobs/process-media.mjs [--dry-run] [--limit N] [--property UUID] [--json]
 *
 * Un média n'est traité qu'une fois (`processed_at`), mais tous les échecs ne
 * se valent pas. Une réponse 404 ou 410 est définitive : l'image n'existe
 * plus, la reprendre à chaque passage ne ferait que la redemander pour rien.
 * Une panne de réseau, un 5xx ou un 429 ne disent rien de l'image — et les
 * confondre coûte cher : au réveil d'une mise en veille, le service repart
 * avant le réseau, rien ne ralentit un échec immédiat, et quatre fils
 * consomment des milliers de médias par minute. C'est arrivé : 1 881 images
 * fermées dans la même minute, leurs empreintes perdues, et avec elles la
 * corroboration photo dont la déduplication a besoin (§6.2).
 *
 * Une panne passagère incrémente donc `process_attempts` sans fermer le
 * média ; il repasse au tour suivant, les moins tentés d'abord. Ce qui échoue
 * MAX_ATTEMPTS fois est fermé quand même, sans quoi une image réellement
 * morte resterait en tête de file. Et une salve d'échecs consécutifs arrête
 * la passe au lieu d'y brûler le compteur de tout le monde : c'est le réseau
 * qui est tombé, pas les images.
 *
 * Les URL relatives (photos du seed, médias déjà locaux) sont résolues contre
 * NEXT_PUBLIC_SITE_URL.
 */
import pg from "pg";
import { createMediaStore } from "../lib/media-store.mjs";
import { buildVariants } from "../lib/media-variants.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DRY = has("dry-run");
const LIMIT = Number(opt("limit", "200"));
// Restreint la file à un bien : retraiter les photos d'une fiche précise
// sans attendre le tour du reste.
const PROPERTY = opt("property", null);
/** Médias traités de front. Voir la boucle plus bas. */
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "1")));
const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
/** Tentatives avant de fermer un média qui échoue sans dire pourquoi. */
const MAX_ATTEMPTS = Number(opt("max-attempts", "5"));
/** Échecs passagers d'affilée, sans une seule réussite, avant d'abandonner la
 *  passe : au-delà, c'est le réseau qui est tombé. */
const GIVE_UP_AFTER = Number(opt("give-up-after", "12"));

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const { rows: pending } = await db.query(
  `SELECT id, url, phash IS NULL AS "needsPhash", process_attempts AS attempts
   FROM media WHERE processed_at IS NULL
     AND ($2::uuid IS NULL OR property_id = $2::uuid)
   ORDER BY process_attempts, created_at LIMIT $1`, [LIMIT, PROPERTY]);
const { rows: [{ count: backlog }] } = await db.query(
  `SELECT count(*) AS count FROM media WHERE processed_at IS NULL`);

if (DRY) {
  const summary = { pending: pending.length, backlog: Number(backlog), processed: 0, failed: 0 };
  console.log(has("json") ? JSON.stringify(summary)
    : `${summary.pending} média(s) seraient traités (${summary.backlog} en file).`);
  await db.end();
  process.exit(0);
}

const store = createMediaStore();
let processed = 0, failed = 0, retried = 0;

// Un média se traite indépendamment des autres : téléchargement puis encodage,
// sans état partagé. Les traiter un par un laisse le réseau et les cœurs à
// l'arrêt à tour de rôle — sur un rattrapage de plusieurs milliers d'images,
// c'est la différence entre dix minutes et deux heures. Le défaut reste 1,
// pour que le comportement de la file ne change pas sans qu'on le demande.
const queue = pending.slice();

// Une salve d'échecs passagers sans une seule réussite : c'est le réseau, pas
// les images. On arrête la passe plutôt que d'incrémenter le compteur de tous
// les médias restants — cinq passages ainsi et la file entière serait fermée.
let streak = 0, abandoned = false;

async function worker() {
  while (queue.length && !abandoned) {
    const media = queue.shift();
    await handle(media);
  }
}

/**
 * Une erreur qui condamne l'image, par opposition à une qui condamne l'instant.
 *
 * Seules les réponses du serveur de l'image tranchent, et seulement celles qui
 * disent « cette adresse n'a rien à donner » : 404, 410, et les autres 4xx
 * hors 408 et 429, qui parlent de la demande et non de la ressource. Tout le
 * reste — `fetch failed`, coupure, 5xx, limitation de débit — est passager
 * par défaut, parce que se tromper dans ce sens ne coûte qu'un essai de plus,
 * alors que l'inverse perd l'image.
 */
const PERMANENT = /^source (4\d\d)$/;
function isPermanent(message) {
  const m = String(message).match(PERMANENT);
  if (!m) return false;
  const status = Number(m[1]);
  return status !== 408 && status !== 429;
}

async function handle(media) {
  try {
    const source = media.url.startsWith("/") ? `${SITE}${media.url}` : media.url;
    const res = await fetch(source);
    if (!res.ok) throw new Error(`source ${res.status}`);
    const input = Buffer.from(await res.arrayBuffer());

    const built = await buildVariants(input);
    const variants = [];
    for (const file of built.files) {
      const key = `p/${media.id}/${file.width}.${file.format === "jpeg" ? "jpg" : file.format}`;
      const url = await store.put(key, file.body, file.contentType);
      variants.push({ url, format: file.format, width: file.width,
                      height: file.height, bytes: file.body.length });
    }

    await db.query(
      `UPDATE media SET variants = $2::jsonb,
              width = COALESCE(width, $3), height = COALESCE(height, $4),
              phash = COALESCE(phash, $5::bit(64)),
              processed_at = now(), process_error = NULL
       WHERE id = $1`,
      [media.id, JSON.stringify(variants), built.width, built.height,
       media.needsPhash ? built.phash : null]);
    processed++;
    streak = 0;
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 300);
    const attempts = media.attempts + 1;
    // Définitif, ou trop de fois essayé : le média sort de la file, avec la
    // raison. Sinon il y reste et repassera, les moins tentés d'abord.
    const close = isPermanent(message) || attempts >= MAX_ATTEMPTS;
    await db.query(
      `UPDATE media SET process_attempts = $3, process_error = $2,
              processed_at = CASE WHEN $4 THEN now() ELSE NULL END
        WHERE id = $1`,
      [media.id, message, attempts, close]);
    if (close) failed++; else retried++;
    if (!isPermanent(message) && ++streak >= GIVE_UP_AFTER) abandoned = true;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const summary = { pending: pending.length, backlog: Number(backlog), processed, failed,
                  retried, abandoned };
console.log(has("json") ? JSON.stringify(summary)
  : `${processed} traité(s), ${failed} échec(s) définitif(s), ${retried} à reprendre, `
    + `${summary.backlog - processed - failed} restant(s)`
    + (abandoned ? ` — passe abandonnée après ${GIVE_UP_AFTER} échecs d'affilée : réseau ?` : "."));
await db.end();
process.exit(0);
