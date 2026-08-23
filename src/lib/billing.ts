import "server-only";
import { query, queryOne } from "./db";

/**
 * Lectures de facturation et de quotas (phase 3 — §8).
 *
 * Les écritures (changement de palier, pointage d'une facture, mise en
 * avant) vivent dans les actions du back-office ; la logique partagée avec
 * les jobs est dans `db/lib/billing.mjs`. Ici, uniquement ce que les pages
 * affichent.
 */

export interface Plan {
  tier: string;
  priceUsdMonth: string;
  listingQuota: number;
  featuredSlots: number;
}

export function listPlans() {
  return query<Plan>(
    `SELECT tier::text, price_usd_month AS "priceUsdMonth",
            listing_quota AS "listingQuota", featured_slots AS "featuredSlots"
     FROM plans ORDER BY price_usd_month`);
}

export interface Invoice {
  id: string;
  number: string;
  agencyName: string;
  tier: string;
  periodStart: string;
  amountUsd: string;
  status: "issued" | "paid" | "void";
  dueAt: string;
  paidAt: string | null;
  overdue: boolean;
}

const INVOICE_COLUMNS = `
  i.id, i.number, i.agency_name AS "agencyName", i.tier::text,
  i.period_start AS "periodStart", i.amount_usd AS "amountUsd",
  i.status::text AS status, i.due_at AS "dueAt", i.paid_at AS "paidAt",
  (i.status = 'issued' AND i.due_at < now()) AS overdue`;

/** Les factures d'une agence, les plus récentes d'abord. */
export function agencyInvoices(agencyId: string, limit = 12) {
  return query<Invoice>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices i
     WHERE i.agency_id = $1 ORDER BY i.period_start DESC, i.issued_at DESC LIMIT $2`,
    [agencyId, limit]);
}

export interface BillingUsage {
  tier: string;
  priceUsdMonth: string;
  listingQuota: number;
  featuredQuota: number;
  activeListings: number;
  featuredActive: number;
  heldListings: number;
}

/** Consommation du palier : places d'annonces et de mises en avant. */
export async function billingUsage(agencyId: string): Promise<BillingUsage | null> {
  return queryOne<BillingUsage>(
    `SELECT a.subscription_tier::text AS tier,
            COALESCE(p.price_usd_month, 0) AS "priceUsdMonth",
            a.listing_quota AS "listingQuota", a.featured_quota AS "featuredQuota",
            (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'active')::int AS "activeListings",
            (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'active' AND l.featured)::int AS "featuredActive",
            (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'pending')::int AS "heldListings"
     FROM agencies a LEFT JOIN plans p ON p.tier = a.subscription_tier
     WHERE a.id = $1`,
    [agencyId]);
}

export interface AgencyBillingRow extends BillingUsage {
  id: string;
  name: string;
  slug: string;
  openInvoices: number;
  overdueInvoices: number;
}

/** Vue d'ensemble pour la modération : une ligne par agence. */
export function billingOverview() {
  return query<AgencyBillingRow>(
    `SELECT a.id, a.name, a.slug, a.subscription_tier::text AS tier,
            COALESCE(p.price_usd_month, 0) AS "priceUsdMonth",
            a.listing_quota AS "listingQuota", a.featured_quota AS "featuredQuota",
            (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'active')::int AS "activeListings",
            (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'active' AND l.featured)::int AS "featuredActive",
            (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'pending')::int AS "heldListings",
            (SELECT count(*) FROM invoices i
              WHERE i.agency_id = a.id AND i.status = 'issued')::int AS "openInvoices",
            (SELECT count(*) FROM invoices i
              WHERE i.agency_id = a.id AND i.status = 'issued' AND i.due_at < now())::int
              AS "overdueInvoices"
     FROM agencies a LEFT JOIN plans p ON p.tier = a.subscription_tier
     ORDER BY p.price_usd_month DESC NULLS LAST, a.name`);
}

/** Factures émises non réglées, tous clients confondus — la liste de travail
 *  de la modération, les retards d'abord. */
export function openInvoices(limit = 20) {
  return query<Invoice>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices i
     WHERE i.status = 'issued'
     ORDER BY (i.due_at < now()) DESC, i.due_at LIMIT $1`,
    [limit]);
}
