import "server-only";
import { query } from "./db";
import { LOCALES, type Locale } from "./i18n";
import { PROPERTY_TYPES } from "./search";

/**
 * Pages d'atterrissage quartier × type × transaction × langue (phase 3).
 *
 * Le SEO multilingue est le canal d'acquisition majeur du portail (principe
 * n°5), mais la combinatoire est un piège : 77 quartiers × 8 types × 2
 * transactions × 4 langues = 4 928 URLs. En générer autant sur un inventaire
 * de quelques centaines de biens produirait des milliers de pages quasi vides
 * et quasi identiques — contenu mince, budget d'exploration gaspillé, et un
 * risque de dévaluation qui retomberait sur tout le site.
 *
 * D'où la règle : une page n'est **indexable** qu'au-dessus d'un seuil
 * d'inventaire. En dessous, elle reste consultable — un visiteur qui suit un
 * lien doit trouver quelque chose — mais porte `noindex, follow` et sort du
 * sitemap. Le seuil se franchit tout seul à mesure que l'offre grossit ; à
 * l'objectif de 3 000 biens de la phase 2, la plupart des combinaisons utiles
 * l'auront passé.
 */
export const INDEX_THRESHOLD = 5;

export const TRANSACTIONS = ["buy", "rent"] as const;
export type TransactionSegment = (typeof TRANSACTIONS)[number];

export const txnFromSegment = (seg: string) =>
  seg === "buy" ? "sale" : seg === "rent" ? "rent" : null;

export interface LandingScope {
  transaction: "sale" | "rent";
  segment: TransactionSegment;
  areaSlug: string;
  typeSlug: string | null;
}

export function landingPath(locale: Locale, scope: LandingScope): string {
  const base = `/${locale}/${scope.segment}/${scope.areaSlug}`;
  return scope.typeSlug ? `${base}/${scope.typeSlug}` : base;
}

/** Alternates hreflang complets, plus x-default (§4.1). */
export function landingAlternates(scope: LandingScope) {
  return {
    // `x-default` se déclare parmi les langues, pas à côté : posé au mauvais
    // niveau, Next ne l'émet tout simplement pas.
    languages: {
      ...Object.fromEntries(
        LOCALES.map((l) => [l === "zh" ? "zh-Hans" : l, landingPath(l, scope)])
      ),
      "x-default": landingPath("en", scope),
    },
  };
}

export interface LandingStats {
  properties: number;
  listings: number;
  agencies: number;
  priceMin: string | null;
  priceMax: string | null;
  priceMedian: string | null;
  pricePerSqm: string | null;
  areaMedian: string | null;
  bedroomsMode: number | null;
  foreignEligible: number;
  freshWithin30: number;
  areaName: Record<string, string>;
  parentSlug: string | null;
  parentName: Record<string, string> | null;
  level: string;
}

/**
 * Chiffres réels de la combinaison. Ils servent à écrire un texte qui ne se
 * répète pas d'une page à l'autre : le prix médian, la part de biens
 * accessibles aux étrangers et la surface typique diffèrent d'un quartier au
 * suivant, donc les pages aussi.
 */
export async function landingStats(scope: LandingScope): Promise<LandingStats | null> {
  const rows = await query<LandingStats>(
    `
    WITH scoped AS (
      SELECT p.id, p.bedrooms, p.foreign_eligible,
             COALESCE(p.indoor_area_sqm, p.land_area_sqm) AS area,
             min(l.price_usd) AS price,
             count(DISTINCT l.agency_id) AS agencies,
             count(*) AS listings,
             max(l.last_confirmed_at) AS confirmed
      FROM properties p
      JOIN locations loc ON loc.id = p.location_id
      JOIN listings l ON l.property_id = p.id AND l.status = 'active'
                     AND l.transaction_type = $1::transaction_type
      WHERE loc.slug = $2
        AND ($3::text IS NULL OR p.property_type = $3::property_type)
      GROUP BY p.id, p.bedrooms, p.foreign_eligible, area
    )
    SELECT
      (SELECT count(*) FROM scoped)::int AS properties,
      (SELECT COALESCE(sum(listings), 0) FROM scoped)::int AS listings,
      (SELECT COALESCE(max(agencies), 0) FROM scoped)::int AS agencies,
      (SELECT min(price) FROM scoped) AS "priceMin",
      (SELECT max(price) FROM scoped) AS "priceMax",
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FROM scoped) AS "priceMedian",
      (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price / NULLIF(area, 0)))
         FROM scoped WHERE area > 0) AS "pricePerSqm",
      (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY area)) FROM scoped) AS "areaMedian",
      (SELECT bedrooms FROM scoped WHERE bedrooms > 0
        GROUP BY bedrooms ORDER BY count(*) DESC, bedrooms LIMIT 1) AS "bedroomsMode",
      (SELECT count(*) FROM scoped WHERE foreign_eligible)::int AS "foreignEligible",
      (SELECT count(*) FROM scoped WHERE confirmed > now() - interval '30 days')::int AS "freshWithin30",
      loc.name_i18n AS "areaName", loc.level::text AS level,
      parent.slug AS "parentSlug", parent.name_i18n AS "parentName"
    FROM locations loc
    LEFT JOIN locations parent ON parent.id = loc.parent_id
    WHERE loc.slug = $2
    `,
    [scope.transaction, scope.areaSlug, scope.typeSlug]
  );
  return rows[0] ?? null;
}

/** Autres types disponibles dans le même quartier — maillage interne. */
export async function siblingTypes(scope: LandingScope) {
  return query<{ type: string; n: number }>(
    `SELECT p.property_type AS type, count(DISTINCT p.id)::int AS n
     FROM properties p
     JOIN locations loc ON loc.id = p.location_id
     JOIN listings l ON l.property_id = p.id AND l.status = 'active'
                    AND l.transaction_type = $1::transaction_type
     WHERE loc.slug = $2 AND ($3::text IS NULL OR p.property_type <> $3::property_type)
     GROUP BY 1 HAVING count(DISTINCT p.id) > 0
     ORDER BY 2 DESC LIMIT 8`,
    [scope.transaction, scope.areaSlug, scope.typeSlug]
  );
}

/** Quartiers voisins ayant le même type — maillage latéral. */
export async function siblingAreas(scope: LandingScope) {
  return query<{ slug: string; name: Record<string, string>; n: number }>(
    `SELECT loc.slug, loc.name_i18n AS name, count(DISTINCT p.id)::int AS n
     FROM locations loc
     JOIN properties p ON p.location_id = loc.id
     JOIN listings l ON l.property_id = p.id AND l.status = 'active'
                    AND l.transaction_type = $1::transaction_type
     WHERE loc.slug <> $2
       AND loc.parent_id = (SELECT parent_id FROM locations WHERE slug = $2)
       AND ($3::text IS NULL OR p.property_type = $3::property_type)
     GROUP BY loc.slug, loc.name_i18n
     HAVING count(DISTINCT p.id) > 0
     ORDER BY 3 DESC LIMIT 8`,
    [scope.transaction, scope.areaSlug, scope.typeSlug]
  );
}

/**
 * Combinaisons franchissant le seuil d'indexation. Sert à la fois au sitemap
 * et à la pré-génération : les deux doivent porter exactement sur le même
 * ensemble, sinon le sitemap annonce des pages en `noindex`.
 */
export async function indexableCombos(threshold = INDEX_THRESHOLD) {
  return query<{ segment: TransactionSegment; areaSlug: string; typeSlug: string | null; n: number }>(
    `
    WITH base AS (
      SELECT loc.slug AS area_slug, p.property_type::text AS type_slug,
             l.transaction_type::text AS txn, count(DISTINCT p.id)::int AS n
      FROM properties p
      JOIN locations loc ON loc.id = p.location_id
      JOIN listings l ON l.property_id = p.id AND l.status = 'active'
      GROUP BY 1, 2, 3
    ),
    with_type AS (SELECT area_slug, type_slug, txn, n FROM base),
    all_types AS (
      SELECT area_slug, NULL::text AS type_slug, txn, sum(n)::int AS n
      FROM base GROUP BY area_slug, txn
    )
    SELECT CASE WHEN txn = 'rent' THEN 'rent' ELSE 'buy' END AS segment,
           area_slug AS "areaSlug", type_slug AS "typeSlug", n
    FROM (SELECT * FROM with_type UNION ALL SELECT * FROM all_types) x
    WHERE n >= $1
    ORDER BY n DESC
    `,
    [threshold]
  );
}

export const isPropertyType = (value: string): boolean =>
  (PROPERTY_TYPES as readonly string[]).includes(value);
