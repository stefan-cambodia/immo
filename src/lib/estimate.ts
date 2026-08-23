import "server-only";
import { query, queryOne } from "./db";

/**
 * Estimation de prix par quartier (phase 4).
 *
 * La méthode est volontairement simple et explicable : médiane du prix au m²
 * des biens comparables (même type, même transaction) dans le quartier,
 * multipliée par la surface. Pas de modèle opaque — le portail vend de la
 * confiance, et une estimation ne vaut que si l'on peut dire d'où elle sort :
 * combien de comparables, sur quel périmètre, et avec quelle fourchette.
 *
 * Quand le quartier n'a pas assez de comparables, l'estimation élargit au
 * district, puis à la province, puis au pays entier — et le dit. La tendance
 * vient de `price_history`, alimentée par trigger à chaque création et à
 * chaque changement de prix (§6.3).
 */

/** En dessous, on élargit le périmètre ; au-dessus au rang 0, confiance haute. */
export const MIN_SAMPLE = 5;
export const GOOD_SAMPLE = 15;
/** Une annonce partie depuis moins de 6 mois reste un comparable valable. */
export const LOOKBACK_DAYS = 180;

export interface EstimateInput {
  locationSlug: string;
  propertyType: string;
  transaction: "sale" | "rent";
  areaSqm: number;
}

export interface ComparableStats {
  n: number;
  perSqmMedian: number;
  perSqmP25: number;
  perSqmP75: number;
  priceMedian: number;
}

export interface Estimate {
  /** Périmètre réellement utilisé (rang 0 = le lieu demandé). */
  level: "exact" | "parent" | "grandparent" | "country";
  usedSlug: string | null;
  usedName: Record<string, string> | null;
  requestedName: Record<string, string>;
  stats: ComparableStats;
  value: number;
  low: number;
  high: number;
  confidence: "high" | "medium" | "low";
}

interface ChainRow {
  id: string;
  slug: string;
  name: Record<string, string>;
  depth: number;
}

const statsSql = (scoped: boolean) => `
  WITH RECURSIVE tree AS (
    SELECT id FROM locations WHERE id = $4::uuid
    UNION ALL SELECT c.id FROM locations c JOIN tree ON c.parent_id = tree.id
  ),
  per_property AS (
    SELECT p.id, min(l.price_usd) AS price,
           COALESCE(p.indoor_area_sqm, p.land_area_sqm) AS area
    FROM properties p
    JOIN listings l ON l.property_id = p.id
      AND l.transaction_type = $1::transaction_type
      AND (l.status = 'active'
           OR (l.status IN ('expired', 'sold')
               AND l.updated_at > now() - ($3 || ' days')::interval))
    WHERE p.property_type = $2::property_type
      AND COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
      ${scoped ? "AND p.location_id IN (SELECT id FROM tree)" : ""}
    GROUP BY p.id
  )
  SELECT count(*)::int AS n,
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY price / area), 0)::float8 AS "perSqmMedian",
         COALESCE(percentile_cont(0.25) WITHIN GROUP (ORDER BY price / area), 0)::float8 AS "perSqmP25",
         COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY price / area), 0)::float8 AS "perSqmP75",
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY price), 0)::float8 AS "priceMedian"
  FROM per_property
`;

async function comparablesAt(
  locationId: string | null, propertyType: string, transaction: string
): Promise<ComparableStats> {
  const row = await queryOne<ComparableStats>(
    statsSql(locationId !== null),
    // $4 est toujours lié — la CTE le référence même hors périmètre.
    [transaction, propertyType, LOOKBACK_DAYS,
     locationId ?? "00000000-0000-0000-0000-000000000000"]
  );
  return row ?? { n: 0, perSqmMedian: 0, perSqmP25: 0, perSqmP75: 0, priceMedian: 0 };
}

interface Resolved {
  level: Estimate["level"];
  usedSlug: string | null;
  usedName: Record<string, string> | null;
  requestedName: Record<string, string>;
  stats: ComparableStats;
}

/**
 * Gravit l'échelle administrative (lieu demandé → parent → grand-parent →
 * pays) jusqu'au premier rang qui porte assez de comparables.
 */
async function resolveComparables(
  locationSlug: string, propertyType: string, transaction: string
): Promise<Resolved | null> {
  const chain = await query<ChainRow>(
    `
    WITH RECURSIVE up AS (
      SELECT id, slug, name_i18n AS name, parent_id, 0 AS depth
      FROM locations WHERE slug = $1
      UNION ALL
      SELECT l.id, l.slug, l.name_i18n, l.parent_id, up.depth + 1
      FROM locations l JOIN up ON l.id = up.parent_id
    )
    SELECT id, slug, name, depth FROM up ORDER BY depth
    `,
    [locationSlug]
  );
  if (chain.length === 0) return null;

  const LEVELS = ["exact", "parent", "grandparent"] as const;
  for (let i = 0; i < chain.length && i < LEVELS.length; i++) {
    const stats = await comparablesAt(chain[i].id, propertyType, transaction);
    if (stats.n >= MIN_SAMPLE) {
      return {
        level: LEVELS[i],
        usedSlug: chain[i].slug,
        usedName: chain[i].name,
        requestedName: chain[0].name,
        stats,
      };
    }
  }

  const country = await comparablesAt(null, propertyType, transaction);
  if (country.n < MIN_SAMPLE) return null;
  return {
    level: "country", usedSlug: null, usedName: null,
    requestedName: chain[0].name, stats: country,
  };
}

export async function estimate(input: EstimateInput): Promise<Estimate | null> {
  const resolved = await resolveComparables(
    input.locationSlug, input.propertyType, input.transaction);
  return resolved ? withValue(input, resolved) : null;
}

function withValue(
  input: EstimateInput,
  base: Omit<Estimate, "value" | "low" | "high" | "confidence">
): Estimate {
  const round = (v: number) =>
    // Arrondi à un pas lisible : personne ne croit un prix au dollar près.
    input.transaction === "rent"
      ? Math.round(v / 10) * 10
      : Math.round(v / 500) * 500;
  const confidence =
    base.level === "exact" && base.stats.n >= GOOD_SAMPLE ? "high"
    : base.level === "exact" || base.level === "parent" ? "medium"
    : "low";
  return {
    ...base,
    value: round(base.stats.perSqmMedian * input.areaSqm),
    low: round(base.stats.perSqmP25 * input.areaSqm),
    high: round(base.stats.perSqmP75 * input.areaSqm),
    confidence,
  };
}

export interface TrendPoint {
  month: string;
  perSqm: number;
  n: number;
}

/**
 * Médiane mensuelle du prix au m² observé sur 12 mois, dans le périmètre que
 * l'estimation a réellement utilisé. Chaque ligne de `price_history` est une
 * observation : prix initial à la création, puis chaque changement.
 */
export async function priceTrend(
  usedSlug: string | null, propertyType: string, transaction: string
): Promise<TrendPoint[]> {
  return query<TrendPoint>(
    `
    WITH RECURSIVE tree AS (
      SELECT id FROM locations WHERE slug = $3
      UNION ALL SELECT c.id FROM locations c JOIN tree ON c.parent_id = tree.id
    )
    SELECT to_char(date_trunc('month', ph.recorded_at), 'YYYY-MM') AS month,
           round(percentile_cont(0.5) WITHIN GROUP
             (ORDER BY ph.price_usd / COALESCE(p.indoor_area_sqm, p.land_area_sqm)))::float8
             AS "perSqm",
           count(*)::int AS n
    FROM price_history ph
    JOIN listings l ON l.id = ph.listing_id AND l.transaction_type = $1::transaction_type
    JOIN properties p ON p.id = l.property_id AND p.property_type = $2::property_type
    WHERE COALESCE(p.indoor_area_sqm, p.land_area_sqm) > 0
      AND ph.recorded_at > now() - interval '12 months'
      AND ($3::text IS NULL OR p.location_id IN (SELECT id FROM tree))
    GROUP BY 1
    HAVING count(*) >= 3
    ORDER BY 1
    `,
    [transaction, propertyType, usedSlug]
  );
}

export interface YieldEstimate {
  /** Rendement locatif brut : loyer annuel médian / prix médian, en %. */
  grossPct: number;
  salePerSqm: number;
  rentPerSqm: number;
  saleN: number;
  rentN: number;
  /** Le rang le plus large des deux côtés — c'est lui qui borne la confiance. */
  level: Estimate["level"];
  usedName: Record<string, string> | null;
}

const LEVEL_ORDER: Estimate["level"][] = ["exact", "parent", "grandparent", "country"];

/**
 * Rendement locatif brut estimé d'une combinaison quartier × type (phase 4).
 *
 * Les médianes au m² côté vente et côté location se résolvent chacune sur
 * l'échelle administrative ; la surface se simplifie, le rendement est une
 * propriété du secteur. Brut veut dire brut : hors charges, impôts et vacance
 * — la page le dit. Muet si l'un des deux côtés doit s'élargir au pays
 * entier : un « rendement par quartier » calculé sur le pays n'en est pas un.
 */
export async function rentalYield(
  locationSlug: string, propertyType: string
): Promise<YieldEstimate | null> {
  const [sale, rent] = await Promise.all([
    resolveComparables(locationSlug, propertyType, "sale"),
    resolveComparables(locationSlug, propertyType, "rent"),
  ]);
  if (!sale || !rent) return null;
  if (sale.level === "country" || rent.level === "country") return null;
  if (sale.stats.perSqmMedian <= 0 || rent.stats.perSqmMedian <= 0) return null;

  const wider = LEVEL_ORDER.indexOf(sale.level) >= LEVEL_ORDER.indexOf(rent.level) ? sale : rent;
  return {
    grossPct: (rent.stats.perSqmMedian * 12 / sale.stats.perSqmMedian) * 100,
    salePerSqm: sale.stats.perSqmMedian,
    rentPerSqm: rent.stats.perSqmMedian,
    saleN: sale.stats.n,
    rentN: rent.stats.n,
    level: wider.level,
    usedName: wider.usedName,
  };
}

export interface PricePosition {
  perSqm: number;
  medianPerSqm: number;
  deltaPct: number;
  n: number;
  usedName: Record<string, string> | null;
  level: Estimate["level"];
}

/**
 * Position d'un bien par rapport à la médiane de son quartier — affichée sur
 * la fiche. Ne dit rien sous MIN_SAMPLE comparables : un écart calculé sur
 * trois biens est du bruit présenté comme un fait.
 */
export async function pricePosition(
  locationSlug: string, propertyType: string, transaction: string,
  price: number, areaSqm: number
): Promise<PricePosition | null> {
  if (!(areaSqm > 0) || !(price > 0)) return null;
  const est = await estimate({
    locationSlug, propertyType,
    transaction: transaction as "sale" | "rent",
    areaSqm,
  });
  if (!est || est.level === "country" || est.stats.perSqmMedian <= 0) return null;
  const perSqm = price / areaSqm;
  return {
    perSqm,
    medianPerSqm: est.stats.perSqmMedian,
    deltaPct: Math.round(((perSqm - est.stats.perSqmMedian) / est.stats.perSqmMedian) * 100),
    n: est.stats.n,
    usedName: est.usedName,
    level: est.level,
  };
}
