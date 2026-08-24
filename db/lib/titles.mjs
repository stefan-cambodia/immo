/**
 * Vérification documentaire des titres (phase 4) — machine à états partagée.
 *
 * Comme la facturation, ce module est en ESM simple pour servir les actions du
 * back-office ET les scripts de contrôle : la règle « qui peut passer à quel
 * état, et ce que la conclusion fait au bien » vit ici, à un seul endroit.
 *
 * demandé → documents reçus → en examen → confirmé | rejeté.
 * Toutes les fonctions s'appellent DANS une transaction : la conclusion écrit
 * sur le dossier et sur le bien, et les deux doivent rester d'accord.
 */

export const OPEN_STATUSES = ["requested", "documents_received", "in_review"];

const RETURNING = `
  id, property_id AS "propertyId", partner_id AS "partnerId",
  property_reference AS "reference", partner_name AS "partner",
  claimed_title::text AS "claimedTitle", status::text AS status,
  confirmed_title::text AS "confirmedTitle", note,
  requested_at AS "requestedAt", concluded_at AS "concludedAt"`;

/**
 * Ouvre un dossier pour un bien, avec instantanés (référence, partenaire,
 * titre déclaré à cet instant). Refuse un second dossier ouvert : renvoie
 * "already_open" — l'index partiel unique reste le filet contre la course.
 */
export async function openVerification(db, { propertyId, partnerId, requestedBy }) {
  const { rows: [property] } = await db.query(
    `SELECT reference, title_type::text AS claimed FROM properties WHERE id = $1`,
    [propertyId]);
  if (!property) return null;
  const { rows: [partner] } = await db.query(
    `SELECT name FROM verification_partners WHERE id = $1 AND active`, [partnerId]);
  if (!partner) return null;

  const { rows: open } = await db.query(
    `SELECT 1 FROM title_verifications
     WHERE property_id = $1 AND status = ANY($2::title_verification_status[])`,
    [propertyId, OPEN_STATUSES]);
  if (open.length > 0) return "already_open";

  const { rows: [v] } = await db.query(
    `INSERT INTO title_verifications(property_id, partner_id, property_reference,
       partner_name, claimed_title, requested_by)
     VALUES ($1, $2, $3, $4, $5::title_type, $6)
     RETURNING ${RETURNING}`,
    [propertyId, partnerId, property.reference, partner.name, property.claimed, requestedBy]);
  return v;
}

/** Transitions intermédiaires autorisées : vers → depuis. */
const STEPS = {
  documents_received: ["requested"],
  in_review: ["documents_received"],
};

/**
 * Avance un dossier d'un cran. Renvoie le dossier mis à jour, ou null si la
 * transition n'existe pas — un double clic ou un dossier déjà conclu ne font
 * rien, sans erreur.
 */
export async function advanceVerification(db, id, next) {
  const from = STEPS[next];
  if (!from) return null;
  const { rows: [v] } = await db.query(
    `UPDATE title_verifications
     SET status = $2::title_verification_status,
         documents_received_at = CASE WHEN $2 = 'documents_received'
                                      THEN now() ELSE documents_received_at END
     WHERE id = $1 AND status = ANY($3::title_verification_status[])
     RETURNING ${RETURNING}`,
    [id, next, from]);
  return v ?? null;
}

/**
 * Conclut un dossier.
 *
 * - 'confirmed' : exige d'avoir au moins reçu les documents, et un
 *   `confirmedTitle`. Le bien est CORRIGÉ avec le titre établi — le badge ne
 *   doit jamais contredire la fiche — et `foreign_eligible` se recalcule
 *   (colonne générée).
 * - 'rejected' : possible à tout stade ouvert. Retire le badge d'une
 *   confirmation antérieure : la conclusion la plus récente fait foi.
 *
 * Renvoie { verification, previousTitle } ou null si rien à conclure.
 */
export async function concludeVerification(db, id, conclusion) {
  const { outcome, confirmedTitle = null, note = null } = conclusion;
  if (outcome === "confirmed" && !confirmedTitle) return null;
  const from = outcome === "confirmed"
    ? ["documents_received", "in_review"]
    : outcome === "rejected" ? OPEN_STATUSES : null;
  if (!from) return null;

  const { rows: [v] } = await db.query(
    `UPDATE title_verifications
     SET status = $2::title_verification_status, concluded_at = now(),
         confirmed_title = CASE WHEN $2 = 'confirmed' THEN $3::title_type END,
         note = $4
     WHERE id = $1 AND status = ANY($5::title_verification_status[])
     RETURNING ${RETURNING}`,
    [id, outcome, confirmedTitle, note, from]);
  if (!v) return null;

  const { rows: [before] } = await db.query(
    `SELECT title_type::text AS title FROM properties WHERE id = $1`, [v.propertyId]);

  if (outcome === "confirmed") {
    await db.query(
      `UPDATE properties
       SET title_type = $2::title_type, title_verified_at = now(),
           title_verified_by = $3, updated_at = now()
       WHERE id = $1`,
      [v.propertyId, confirmedTitle, v.partner]);
  } else {
    await db.query(
      `UPDATE properties
       SET title_verified_at = NULL, title_verified_by = NULL, updated_at = now()
       WHERE id = $1`,
      [v.propertyId]);
  }

  return { verification: v, previousTitle: before?.title ?? null };
}

/** Dossiers ouverts puis conclusions récentes, pour le panneau de modération. */
export async function listVerifications(db, limit = 12) {
  const { rows } = await db.query(
    `SELECT ${RETURNING}
     FROM title_verifications
     ORDER BY status = ANY($1::title_verification_status[]) DESC,
              concluded_at DESC NULLS FIRST, requested_at
     LIMIT $2`,
    [OPEN_STATUSES, limit]);
  return rows;
}

export async function listPartners(db) {
  const { rows } = await db.query(
    `SELECT id, slug, name, contact FROM verification_partners
     WHERE active ORDER BY name`);
  return rows;
}
