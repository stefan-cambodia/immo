/**
 * API partenaires (phase 4) — clés, authentification, quota.
 *
 * Comme la facturation et les titres, ce module est en ESM simple pour
 * servir à la fois les routes Next, les actions du back-office et les
 * scripts de contrôle : la règle « qu'est-ce qu'une clé valide et combien
 * peut-elle appeler » vit ici, à un seul endroit.
 *
 * La clé complète n'existe qu'à deux moments : à la génération (affichée
 * une fois) et dans l'en-tête des requêtes du partenaire. En base, seuls
 * vivent son hachage SHA-256 et un préfixe d'identification.
 */
import { createHash, randomBytes } from "node:crypto";

/** Préfixe de schéma : identifie une clé du portail dans un journal ou un
 *  gestionnaire de secrets, sans rien révéler. */
export const KEY_SCHEME = "ci_";

export function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

/** 24 octets d'aléa (192 bits) : hors de portée d'une recherche exhaustive,
 *  donc la consultation par hachage exact suffit à l'authentification. */
export function generateApiKey() {
  const key = KEY_SCHEME + randomBytes(24).toString("base64url");
  return { key, prefix: key.slice(0, 11), hash: hashApiKey(key) };
}

// ---------------------------------------------------------------------------
// Gestion (back-office)
// ---------------------------------------------------------------------------

export async function createApiPartner(db, { slug, name, contact }) {
  const { rows: [p] } = await db.query(
    `INSERT INTO api_partners(slug, name, contact) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, name, contact, active`,
    [slug, name, contact ?? null]);
  return p ?? null; // null : slug déjà pris
}

/** Émet une clé et renvoie — une seule fois — sa valeur en clair. */
export async function issueApiKey(db, { partnerId, label = "", dailyQuota = 5000 }) {
  const { rows: [partner] } = await db.query(
    `SELECT id, name FROM api_partners WHERE id = $1`, [partnerId]);
  if (!partner) return null;

  const { key, prefix, hash } = generateApiKey();
  const { rows: [row] } = await db.query(
    `INSERT INTO api_keys(partner_id, key_prefix, key_hash, label, daily_quota)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, key_prefix AS prefix, label, daily_quota AS "dailyQuota"`,
    [partnerId, prefix, hash, label.slice(0, 80), dailyQuota]);
  return { ...row, key, partnerName: partner.name };
}

/** Révoque une clé. Idempotent : une clé déjà révoquée ne bouge plus. */
export async function revokeApiKey(db, keyId) {
  const { rows: [row] } = await db.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id, key_prefix AS prefix, partner_id AS "partnerId"`,
    [keyId]);
  return row ?? null;
}

/** Partenaires et clés pour le panneau du back-office, usage du jour inclus. */
export async function listApiPartners(db) {
  const { rows } = await db.query(
    `SELECT p.id, p.slug, p.name, p.contact, p.active,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', k.id, 'prefix', k.key_prefix, 'label', k.label,
              'dailyQuota', k.daily_quota, 'createdAt', k.created_at,
              'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at,
              'usedToday', coalesce(u.count, 0)) ORDER BY k.created_at DESC)
              FILTER (WHERE k.id IS NOT NULL), '[]'::jsonb) AS keys
     FROM api_partners p
     LEFT JOIN api_keys k ON k.partner_id = p.id
     LEFT JOIN api_usage u ON u.key_id = k.id AND u.day = current_date
     GROUP BY p.id
     ORDER BY p.name`);
  return rows;
}

// ---------------------------------------------------------------------------
// Authentification et quota (routes)
// ---------------------------------------------------------------------------

/**
 * Authentifie une clé brute.
 *
 * Renvoie null pour une clé inconnue (401), `{ ok: false, reason }` pour une
 * clé reconnue mais fermée (403 — révoquée ou partenaire désactivé), et le
 * contexte partenaire quand tout est en règle. La distinction compte : un
 * partenaire dont la clé vient d'être révoquée doit comprendre pourquoi ses
 * appels échouent, pas croire à une clé mal copiée.
 */
export async function authenticateApiKey(db, rawKey) {
  if (!rawKey || !rawKey.startsWith(KEY_SCHEME)) return null;
  const { rows: [k] } = await db.query(
    `SELECT k.id AS "keyId", k.daily_quota AS "dailyQuota",
            k.revoked_at IS NOT NULL AS revoked,
            p.active, p.id AS "partnerId", p.slug AS "partnerSlug", p.name AS "partnerName"
     FROM api_keys k JOIN api_partners p ON p.id = k.partner_id
     WHERE k.key_hash = $1`,
    [hashApiKey(rawKey)]);
  if (!k) return null;
  if (k.revoked) return { ok: false, reason: "key_revoked" };
  if (!k.active) return { ok: false, reason: "partner_inactive" };
  return { ok: true, keyId: k.keyId, partnerId: k.partnerId,
           partnerSlug: k.partnerSlug, partnerName: k.partnerName,
           dailyQuota: k.dailyQuota };
}

/** Consomme une unité de quota ; renvoie le solde (négatif = refusée). */
export async function consumeApiQuota(db, keyId) {
  const { rows: [r] } = await db.query(`SELECT api_consume($1) AS remaining`, [keyId]);
  return r?.remaining ?? null;
}
