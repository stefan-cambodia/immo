/**
 * Gestion des comptes — invitations et réinitialisations de mot de passe.
 *
 * ESM simple partagé entre les actions Next et les scripts de contrôle,
 * comme la facturation, les titres et l'API partenaires. Le hachage du MOT
 * DE PASSE reste chez l'appelant (scrypt dans `src/lib/auth.ts`, dupliqué
 * par le seed) : ce module ne connaît que les jetons et les règles du
 * circuit — qui peut en obtenir un, combien de temps il vit, ce que sa
 * consommation déclenche.
 *
 * Un jeton est à usage unique, stocké haché (SHA-256), et sa consommation
 * est atomique : deux soumissions simultanées du même lien ne posent
 * qu'un seul mot de passe.
 */
import { createHash, randomBytes } from "node:crypto";

export const INVITE_TTL = "7 days";
export const RESET_TTL = "1 hour";

/** Limitation des demandes de réinitialisation. */
export const RESET_MAX_PER_EMAIL = 3; // par heure
export const RESET_MAX_PER_IP = 12;   // par heure

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

export function generateAccountToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

// ---------------------------------------------------------------------------
// Comptes (modération)
// ---------------------------------------------------------------------------

/**
 * Crée un compte sans mot de passe utilisable : le hachage posé est un
 * leurre jamais dérivé d'un texte — personne ne peut se connecter avant
 * d'avoir consommé l'invitation. Renvoie null si l'adresse est déjà prise.
 */
export async function createAccount(db, { email, name, role, agencyId }) {
  const normalized = email.trim().toLowerCase();
  const { rows: existing } = await db.query(
    `SELECT 1 FROM users WHERE lower(email) = $1`, [normalized]);
  if (existing.length > 0) return null;

  const decoy = `scrypt$${"0".repeat(32)}$${randomBytes(64).toString("hex")}`;
  const { rows: [user] } = await db.query(
    `INSERT INTO users(email, password_hash, role, agency_id, name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, role::text AS role, agency_id AS "agencyId"`,
    [normalized, decoy, role, role === "admin" ? null : agencyId, name]);
  return user;
}

/** Active ou désactive un compte. Désactiver coupe les sessions en cours et
 *  invalide les jetons ouverts : la révocation est immédiate ou n'est pas. */
export async function setAccountActive(db, userId, active) {
  const { rows: [user] } = await db.query(
    `UPDATE users SET active = $2 WHERE id = $1 AND active <> $2
     RETURNING id, email, name`, [userId, active]);
  if (!user) return null;
  if (!active) {
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await db.query(
      `UPDATE account_tokens SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  }
  return user;
}

/** Comptes et invitation ouverte éventuelle, pour le panneau de modération. */
export async function listAccounts(db) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role::text AS role, u.active,
            u.last_login_at AS "lastLoginAt", a.name AS "agencyName",
            i.expires_at AS "inviteExpiresAt"
     FROM users u
     LEFT JOIN agencies a ON a.id = u.agency_id
     LEFT JOIN LATERAL (
       SELECT expires_at FROM account_tokens t
       WHERE t.user_id = u.id AND t.purpose = 'invite'
         AND t.used_at IS NULL AND t.expires_at > now()
       ORDER BY t.created_at DESC LIMIT 1
     ) i ON true
     ORDER BY u.role, a.name NULLS FIRST, u.email`);
  return rows;
}

// ---------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------

/**
 * Émet un jeton pour un compte actif et renvoie — une seule fois — sa
 * valeur en clair. Les jetons ouverts du même usage sont invalidés : un
 * lien de réinitialisation par personne, le dernier envoyé fait foi.
 */
export async function issueToken(db, { userId, purpose, createdBy }) {
  const { rows: [user] } = await db.query(
    `SELECT id, email, name FROM users WHERE id = $1 AND active`, [userId]);
  if (!user) return null;

  await db.query(
    `UPDATE account_tokens SET used_at = now()
     WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose]);

  const { token, hash } = generateAccountToken();
  const ttl = purpose === "invite" ? INVITE_TTL : RESET_TTL;
  const { rows: [row] } = await db.query(
    `INSERT INTO account_tokens(user_id, purpose, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, now() + $4::interval, $5)
     RETURNING id, expires_at AS "expiresAt"`,
    [userId, purpose, hash, ttl, createdBy ?? null]);
  return { token, tokenId: row.id, expiresAt: row.expiresAt,
           email: user.email, name: user.name };
}

/** Regarde un jeton sans le consommer — pour afficher le formulaire. */
export async function peekToken(db, token) {
  if (!token) return null;
  const { rows: [row] } = await db.query(
    `SELECT t.purpose::text AS purpose, u.email, u.name
     FROM account_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL
       AND t.expires_at > now() AND u.active`,
    [hashToken(token)]);
  return row ?? null;
}

/**
 * Consomme un jeton et pose le mot de passe, atomiquement. Toutes les
 * sessions du compte sont coupées : après une réinitialisation, un poste
 * potentiellement compromis ne reste pas connecté. Renvoie le compte, ou
 * null si le jeton est inconnu, périmé, déjà servi, ou le compte fermé.
 */
export async function consumeTokenAndSetPassword(db, { token, passwordHash }) {
  const { rows: [consumed] } = await db.query(
    `UPDATE account_tokens t SET used_at = now()
     FROM users u LEFT JOIN agencies a ON a.id = u.agency_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
       AND u.id = t.user_id AND u.active
     RETURNING t.user_id AS "userId", t.purpose::text AS purpose,
               u.email, u.name, u.role::text AS role, a.name AS "agencyName"`,
    [hashToken(token)]);
  if (!consumed) return null;

  await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`,
    [consumed.userId, passwordHash]);
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [consumed.userId]);
  return consumed;
}

// ---------------------------------------------------------------------------
// Réinitialisation — demande et limitation
// ---------------------------------------------------------------------------

/** La demande est-elle au-delà des seuils ? Compté sur l'heure glissante,
 *  adresses inconnues comprises : marteler des adresses au hasard consomme
 *  le même budget que marteler une vraie. */
export async function resetRateLimited(db, { email, ip }) {
  const { rows: [r] } = await db.query(
    `SELECT (
       (SELECT count(*) FROM password_reset_requests
         WHERE email = $1 AND created_at > now() - interval '1 hour') >= $3
       OR
       ($2::text IS NOT NULL AND (SELECT count(*) FROM password_reset_requests
         WHERE ip = $2 AND created_at > now() - interval '1 hour') >= $4)
     ) AS blocked`,
    [email, ip, RESET_MAX_PER_EMAIL, RESET_MAX_PER_IP]);
  return r.blocked;
}

/**
 * Traite une demande de réinitialisation : journalise, et si l'adresse
 * correspond à un compte actif, émet un jeton. Renvoie le jeton émis ou
 * null — l'appelant répond LA MÊME CHOSE dans les deux cas.
 */
export async function requestReset(db, { email, ip }) {
  const normalized = email.trim().toLowerCase();
  const { rows: [user] } = await db.query(
    `SELECT id FROM users WHERE lower(email) = $1 AND active`, [normalized]);

  await db.query(
    `INSERT INTO password_reset_requests(email, ip, known) VALUES ($1, $2, $3)`,
    [normalized, ip, Boolean(user)]);

  if (!user) return null;
  return issueToken(db, { userId: user.id, purpose: "reset" });
}
