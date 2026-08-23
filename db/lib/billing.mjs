/**
 * Abonnements, quotas et mise en avant (§8) — logique partagée.
 *
 * Comme le socle d'ingestion, ce module est en ESM simple pour servir deux
 * mondes : les actions du back-office (Next.js) et le job de facturation.
 * L'application du quota vit ICI, à côté de `ingest.mjs` qui l'appelle :
 * aucun canal — bot, flux, back-office — ne peut publier sans passer par la
 * même règle.
 */

/** Durée d'une mise en avant achetée. Une durée, pas un état : voir 013. */
export const FEATURED_DAYS = 30;

/** Délai de règlement d'une facture émise. */
export const INVOICE_DUE_DAYS = 14;

export async function getPlans(db) {
  const { rows } = await db.query(
    `SELECT tier::text, price_usd_month AS "priceUsdMonth",
            listing_quota AS "listingQuota", featured_slots AS "featuredSlots"
     FROM plans ORDER BY price_usd_month`);
  return rows;
}

/**
 * Statut à donner à une annonce qui voudrait devenir active : 'active' s'il
 * reste une place dans le quota, 'pending' (retenue) sinon.
 *
 * Le verrou sur la ligne d'agence sérialise les publications concurrentes :
 * deux annonces qui arrivent en même temps pour la dernière place ne peuvent
 * pas passer toutes les deux. À appeler dans la transaction de l'insertion.
 */
export async function holdOrActive(db, agencyId) {
  await db.query(`SELECT 1 FROM agencies WHERE id = $1 FOR UPDATE`, [agencyId]);
  const { rows } = await db.query(
    `SELECT a.listing_quota
            - (SELECT count(*)::int FROM listings l
                WHERE l.agency_id = a.id AND l.status = 'active') AS room
     FROM agencies a WHERE a.id = $1`, [agencyId]);
  return rows.length && rows[0].room > 0 ? "active" : "pending";
}

/**
 * Publie les annonces retenues d'une agence tant que le quota le permet,
 * les plus anciennes d'abord. Appelé quand une place se libère : montée de
 * palier, expiration d'annonces, ajustement de quota.
 *
 * Une annonce retenue repart avec un cycle de fraîcheur neuf : elle n'a
 * jamais été montrée, son compteur de 45 jours n'a pas de raison d'avoir
 * déjà couru.
 */
export async function releaseHeld(db, agencyId) {
  await db.query(`SELECT 1 FROM agencies WHERE id = $1 FOR UPDATE`, [agencyId]);
  const { rows } = await db.query(
    `WITH room AS (
       SELECT greatest(a.listing_quota
                - (SELECT count(*)::int FROM listings l
                    WHERE l.agency_id = a.id AND l.status = 'active'), 0) AS n
       FROM agencies a WHERE a.id = $1
     ),
     cand AS (
       -- DISTINCT ON : deux retenues sur le même bien et la même transaction
       -- ne peuvent pas s'activer ensemble (contrainte d'unicité des actives).
       SELECT DISTINCT ON (l.property_id, l.transaction_type) l.id
       FROM listings l
       WHERE l.agency_id = $1 AND l.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM listings k
               WHERE k.property_id = l.property_id AND k.agency_id = l.agency_id
                 AND k.transaction_type = l.transaction_type AND k.status = 'active')
       ORDER BY l.property_id, l.transaction_type, l.created_at
     )
     UPDATE listings SET status = 'active',
            last_confirmed_at = now(),
            expires_at = now() + interval '45 days',
            updated_at = now()
     WHERE id IN (SELECT id FROM cand ORDER BY id LIMIT (SELECT n FROM room))
     RETURNING id`,
    [agencyId]);
  return rows.length;
}

/**
 * Éteint les mises en avant arrivées à échéance. `featured_until` est
 * conservé : c'est la trace de ce que l'agence a acheté.
 */
export async function expireFeatured(db) {
  const { rows } = await db.query(
    `UPDATE listings SET featured = false, updated_at = now()
     WHERE featured AND featured_until < now()
     RETURNING id, agency_id`);
  return rows.length;
}

/**
 * Émet la facture du mois courant pour une agence, si son palier est payant
 * et qu'aucune facture vivante n'existe pour la période. Renvoie la facture
 * créée, ou null (palier gratuit, ou déjà facturée).
 */
export async function issueInvoiceFor(db, agencyId) {
  const { rows } = await db.query(
    `INSERT INTO invoices(agency_id, agency_name, tier, period_start, period_end,
                          amount_usd, due_at)
     SELECT a.id, a.name, a.subscription_tier,
            date_trunc('month', now())::date,
            (date_trunc('month', now()) + interval '1 month')::date,
            p.price_usd_month,
            now() + make_interval(days => $2)
     FROM agencies a JOIN plans p ON p.tier = a.subscription_tier
     WHERE a.id = $1 AND p.price_usd_month > 0
     ON CONFLICT (agency_id, period_start) WHERE status <> 'void' DO NOTHING
     RETURNING id, number, agency_name AS "agencyName", tier::text,
               period_start AS "periodStart", amount_usd AS "amountUsd",
               due_at AS "dueAt"`,
    [agencyId, INVOICE_DUE_DAYS]);
  return rows[0] ?? null;
}

/**
 * Génération mensuelle : une facture par agence à palier payant pour le mois
 * en cours. Idempotente — l'index partiel écarte les périodes déjà
 * facturées — donc le job peut tourner tous les jours sans rien dupliquer.
 */
export async function generateInvoices(db) {
  const { rows } = await db.query(
    `INSERT INTO invoices(agency_id, agency_name, tier, period_start, period_end,
                          amount_usd, due_at)
     SELECT a.id, a.name, a.subscription_tier,
            date_trunc('month', now())::date,
            (date_trunc('month', now()) + interval '1 month')::date,
            p.price_usd_month,
            now() + make_interval(days => $1)
     FROM agencies a JOIN plans p ON p.tier = a.subscription_tier
     WHERE p.price_usd_month > 0
     ON CONFLICT (agency_id, period_start) WHERE status <> 'void' DO NOTHING
     RETURNING number, agency_name AS "agencyName", amount_usd AS "amountUsd"`,
    [INVOICE_DUE_DAYS]);
  return rows;
}

/** Factures émises dont l'échéance est dépassée — à relancer. */
export async function overdueInvoices(db) {
  const { rows } = await db.query(
    `SELECT i.number, i.agency_name AS "agencyName", i.amount_usd AS "amountUsd",
            i.due_at AS "dueAt",
            (EXTRACT(EPOCH FROM now() - i.due_at) / 86400)::int AS "daysLate"
     FROM invoices i WHERE i.status = 'issued' AND i.due_at < now()
     ORDER BY i.due_at`);
  return rows;
}
