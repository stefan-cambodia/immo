import "server-only";
import { query, queryOne } from "./db";

/**
 * Chiffres du tableau de bord agence (phase 3).
 *
 * Ce que l'agence achète, c'est de la visibilité et des contacts. Le tableau
 * de bord doit donc répondre à trois questions dans cet ordre : combien de
 * gens ont vu mes biens, combien m'ont contacté, et qu'est-ce qui cloche.
 *
 * Toutes les mesures sont comparées à la période précédente de même longueur
 * — un chiffre brut ne dit pas si la situation s'améliore — et, là où c'est
 * pertinent, à la médiane du portail, parce qu'une agence veut savoir si son
 * résultat vient d'elle ou du marché.
 */

export interface Totals {
  views: number; viewsPrev: number;
  leads: number; leadsPrev: number;
  activeListings: number; properties: number;
  quota: number; tier: string; verification: string;
}

export async function agencyTotals(agencyId: string, days = 30): Promise<Totals> {
  const row = await queryOne<Totals>(
    `
    WITH mine AS (
      SELECT DISTINCT l.property_id
      FROM listings l WHERE l.agency_id = $1 AND l.status = 'active'
    )
    SELECT
      (SELECT count(*) FROM property_views v JOIN mine ON mine.property_id = v.property_id
        WHERE v.created_at > now() - make_interval(days => $2::int))::int AS views,
      (SELECT count(*) FROM property_views v JOIN mine ON mine.property_id = v.property_id
        WHERE v.created_at BETWEEN now() - make_interval(days => $2::int * 2)
                              AND now() - make_interval(days => $2::int))::int AS "viewsPrev",
      (SELECT count(*) FROM leads WHERE agency_id = $1
        AND created_at > now() - make_interval(days => $2::int))::int AS leads,
      (SELECT count(*) FROM leads WHERE agency_id = $1
        AND created_at BETWEEN now() - make_interval(days => $2::int * 2)
                          AND now() - make_interval(days => $2::int))::int AS "leadsPrev",
      (SELECT count(*) FROM listings WHERE agency_id = $1 AND status = 'active')::int AS "activeListings",
      (SELECT count(*) FROM mine)::int AS properties,
      a.listing_quota AS quota, a.subscription_tier::text AS tier,
      a.verification_status::text AS verification
    FROM agencies a WHERE a.id = $1
    `,
    [agencyId, days]
  );
  return row!;
}

/** Contacts par canal et par langue : dit où l'agence doit répondre, et en quelle langue. */
export function leadBreakdown(agencyId: string, days = 30) {
  return query<{ channel: string; locale: string; n: number }>(
    `SELECT channel::text, locale::text, count(*)::int AS n FROM leads
     WHERE agency_id = $1 AND created_at > now() - make_interval(days => $2::int)
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [agencyId, days]
  );
}

/** D'où viennent les visiteurs. Sert à savoir si le SEO travaille. */
export function trafficSources(agencyId: string, days = 30) {
  return query<{ source: string; n: number }>(
    `SELECT COALESCE(v.referrer_host, 'direct') AS source, count(*)::int AS n
     FROM property_views v
     WHERE v.created_at > now() - make_interval(days => $2::int)
       AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = v.property_id
                     AND l.agency_id = $1 AND l.status = 'active')
     GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    [agencyId, days]
  );
}

/** Série quotidienne, pour une courbe lisible sans bibliothèque. */
export function dailySeries(agencyId: string, days = 30) {
  return query<{ day: string; views: number; leads: number }>(
    `WITH d AS (
       SELECT generate_series(date_trunc('day', now()) - make_interval(days => $2::int - 1),
                              date_trunc('day', now()), '1 day')::date AS day
     )
     SELECT d.day::text,
            (SELECT count(*) FROM property_views v
              WHERE v.created_at::date = d.day
                AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = v.property_id
                              AND l.agency_id = $1 AND l.status = 'active'))::int AS views,
            (SELECT count(*) FROM leads le
              WHERE le.created_at::date = d.day AND le.agency_id = $1)::int AS leads
     FROM d ORDER BY d.day`,
    [agencyId, days]
  );
}

export interface ListingPerf {
  id: string; reference: string; propertyType: string; price: string;
  views: number; leads: number; area: Record<string, string>;
  lastConfirmed: string; expiresAt: string; agencies: number;
  featured: boolean; featuredUntil: string | null;
}

/** Performance annonce par annonce, triée par ce qui rapporte. */
export function listingPerformance(agencyId: string, days = 30, limit = 12) {
  return query<ListingPerf>(
    `SELECT l.id, p.reference, p.property_type AS "propertyType", l.price_usd AS price,
            loc.name_i18n AS area, l.last_confirmed_at AS "lastConfirmed",
            l.expires_at AS "expiresAt",
            l.featured, l.featured_until AS "featuredUntil",
            (SELECT count(*) FROM property_views v
              WHERE v.property_id = p.id
                AND v.created_at > now() - make_interval(days => $2::int))::int AS views,
            (SELECT count(*) FROM leads le
              WHERE le.listing_id = l.id
                AND le.created_at > now() - make_interval(days => $2::int))::int AS leads,
            (SELECT count(DISTINCT x.agency_id) FROM listings x
              WHERE x.property_id = p.id AND x.status = 'active')::int AS agencies
     FROM listings l
     JOIN properties p ON p.id = l.property_id
     JOIN locations loc ON loc.id = p.location_id
     WHERE l.agency_id = $1 AND l.status = 'active'
     ORDER BY leads DESC, views DESC
     LIMIT $3`,
    [agencyId, days, limit]
  );
}

/** Ce qui demande une action : annonces qui expirent ou qui dorment. */
export function needsAttention(agencyId: string) {
  return query<{ id: string; reference: string; expiresAt: string; lastConfirmed: string; views: number }>(
    `SELECT l.id, p.reference, l.expires_at AS "expiresAt", l.last_confirmed_at AS "lastConfirmed",
            (SELECT count(*) FROM property_views v WHERE v.property_id = p.id
               AND v.created_at > now() - interval '30 days')::int AS views
     FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.agency_id = $1 AND l.status = 'active'
       AND (l.expires_at < now() + interval '7 days'
            OR l.last_confirmed_at < now() - interval '30 days')
     ORDER BY l.expires_at LIMIT 10`,
    [agencyId]
  );
}

/**
 * Comparaison au portail. Une agence qui voit « 12 contacts » ne sait pas si
 * c'est bon ; « 12 contacts, taux de 3,1 % contre 2,4 % sur le portail » le
 * lui dit.
 */
/** Référence portail : volontairement sans identifiant d'agence — c'est la
 *  base de comparaison, elle ne dépend d'aucune agence en particulier. */
export async function benchmark(days = 30) {
  return queryOne<{ portalViews: number; portalLeads: number; medianFreshnessDays: number | null }>(
    `SELECT
       (SELECT count(*) FROM property_views
         WHERE created_at > now() - make_interval(days => $1::int))::int AS "portalViews",
       (SELECT count(*) FROM leads
         WHERE created_at > now() - make_interval(days => $1::int))::int AS "portalLeads",
       (SELECT percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (now() - last_confirmed_at)) / 86400)
         FROM listings WHERE status = 'active')::int AS "medianFreshnessDays"`,
    [days]
  );
}
