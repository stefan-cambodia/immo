import "server-only";
import { query, queryOne } from "./db";
import type { Locale } from "./i18n";

export const PROPERTY_TYPES = ["condo", "borey_house", "villa", "flat_shophouse",
  "land", "commercial", "warehouse", "whole_building"] as const;
export const TITLE_TYPES = ["hard", "soft", "strata", "unknown"] as const;
export const AMENITIES = ["pool", "gym", "parking", "elevator", "security_24h", "generator",
  "balcony", "river_view", "sea_view", "garden", "playground", "cctv", "wifi",
  "pet_friendly", "aircon"] as const;
export const SORTS = ["relevance", "price_asc", "price_desc", "freshest", "area_desc"] as const;

export type Sort = (typeof SORTS)[number];

export interface Filters {
  q: string | null;
  transaction: "sale" | "rent";
  locationSlug: string | null;
  buildingSlug: string | null;
  types: string[];
  priceMin: number | null;
  priceMax: number | null;
  bedsMin: number | null;
  bathsMin: number | null;
  areaMin: number | null;
  floorMin: number | null;
  titles: string[];
  foreignEligible: boolean;
  furnished: boolean;
  amenities: string[];
  confirmedWithin: number | null;
  bbox: [number, number, number, number] | null;
  polygon: [number, number][] | null;
  sort: Sort;
  page: number;
}

export const PAGE_SIZE = 24;

const num = (v: string | undefined) => {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v: string | string[] | undefined, allowed: readonly string[]) => {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : v.split(",");
  return raw.map((x) => x.trim()).filter((x) => allowed.includes(x));
};

export function parseFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const bbox = one("bbox")?.split(",").map(Number);
  const poly = one("polygon");
  return {
    q: one("q")?.trim() || null,
    transaction: one("txn") === "rent" ? "rent" : "sale",
    locationSlug: one("area") || null,
    buildingSlug: one("building") || null,
    types: list(sp["type"], PROPERTY_TYPES),
    priceMin: num(one("pmin")),
    priceMax: num(one("pmax")),
    bedsMin: num(one("beds")),
    bathsMin: num(one("baths")),
    areaMin: num(one("area_min")),
    floorMin: num(one("floor")),
    titles: list(sp["title"], TITLE_TYPES),
    foreignEligible: one("foreign") === "1",
    furnished: one("furnished") === "1",
    amenities: list(sp["amenity"], AMENITIES),
    confirmedWithin: num(one("fresh")),
    bbox: bbox?.length === 4 && bbox.every(Number.isFinite)
      ? (bbox as [number, number, number, number]) : null,
    polygon: poly
      ? poly.split(";").map((p) => p.split(",").map(Number) as [number, number])
          .filter((p) => p.length === 2 && p.every(Number.isFinite))
      : null,
    sort: (SORTS as readonly string[]).includes(one("sort") ?? "")
      ? (one("sort") as Sort) : "relevance",
    page: Math.max(1, num(one("page")) ?? 1),
  };
}

export function filtersToQueryString(f: Partial<Filters>): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.transaction === "rent") p.set("txn", "rent");
  if (f.locationSlug) p.set("area", f.locationSlug);
  if (f.buildingSlug) p.set("building", f.buildingSlug);
  for (const t of f.types ?? []) p.append("type", t);
  if (f.priceMin) p.set("pmin", String(f.priceMin));
  if (f.priceMax) p.set("pmax", String(f.priceMax));
  if (f.bedsMin) p.set("beds", String(f.bedsMin));
  if (f.bathsMin) p.set("baths", String(f.bathsMin));
  if (f.areaMin) p.set("area_min", String(f.areaMin));
  if (f.floorMin) p.set("floor", String(f.floorMin));
  for (const t of f.titles ?? []) p.append("title", t);
  if (f.foreignEligible) p.set("foreign", "1");
  if (f.furnished) p.set("furnished", "1");
  for (const a of f.amenities ?? []) p.append("amenity", a);
  if (f.confirmedWithin) p.set("fresh", String(f.confirmedWithin));
  if (f.bbox) p.set("bbox", f.bbox.join(","));
  if (f.polygon) p.set("polygon", f.polygon.map((c) => c.join(",")).join(";"));
  if (f.sort && f.sort !== "relevance") p.set("sort", f.sort);
  if (f.page && f.page > 1) p.set("page", String(f.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Résolution d'une saisie libre vers une localité ou un immeuble.
// C'est ici que la table d'alias (§5.2) fait tout le travail : « BKK One »,
// « Kampong Som », « 西港 » et « ភ្នំពេញ » doivent tous atterrir quelque part.
// ---------------------------------------------------------------------------
export interface Suggestion {
  kind: "location" | "building";
  slug: string;
  level: string | null;
  name: Record<string, string>;
  parentName: Record<string, string> | null;
  listingCount: number;
  score: number;
}

export async function suggest(text: string, limit = 8): Promise<Suggestion[]> {
  const trimmed = text.trim();
  if (trimmed.length < 2) return [];

  return query<Suggestion>(
    `
    WITH input AS (SELECT lower(unaccent($1)) AS q),
    loc AS (
      SELECT l.slug, l.level::text AS level, l.name_i18n AS name, l.listing_count,
             parent.name_i18n AS parent_name,
             l.aliases
               || ARRAY[l.slug]
               || ARRAY(SELECT v FROM jsonb_each_text(l.name_i18n) AS e(k, v)) AS terms
      FROM locations l
      LEFT JOIN locations parent ON parent.id = l.parent_id
    ),
    bld AS (
      SELECT b.slug, NULL::text AS level, b.name_i18n AS name, 0 AS listing_count,
             l.name_i18n AS parent_name,
             ARRAY[b.slug] || ARRAY(SELECT v FROM jsonb_each_text(b.name_i18n) AS e(k, v)) AS terms
      FROM buildings b JOIN locations l ON l.id = b.location_id
    ),
    scored AS (
      SELECT 'location' AS kind, loc.slug, loc.level, loc.name, loc.parent_name, loc.listing_count,
        (SELECT max(GREATEST(
            similarity(lower(unaccent(term)), input.q),
            CASE WHEN lower(unaccent(term)) = input.q THEN 1.0
                 WHEN lower(unaccent(term)) LIKE input.q || '%' THEN 0.92
                 WHEN position(input.q in lower(unaccent(term))) > 0 THEN 0.7
                 ELSE 0 END))
         FROM unnest(loc.terms) term, input) AS score
      FROM loc
      UNION ALL
      SELECT 'building', bld.slug, bld.level, bld.name, bld.parent_name, bld.listing_count,
        (SELECT max(GREATEST(
            similarity(lower(unaccent(term)), input.q),
            CASE WHEN lower(unaccent(term)) = input.q THEN 1.0
                 WHEN lower(unaccent(term)) LIKE input.q || '%' THEN 0.92
                 WHEN position(input.q in lower(unaccent(term))) > 0 THEN 0.7
                 ELSE 0 END))
         FROM unnest(bld.terms) term, input) AS score
      FROM bld
    )
    SELECT kind, slug, level, name, parent_name AS "parentName",
           listing_count AS "listingCount", round(score::numeric, 3)::float8 AS score
    FROM scored WHERE score >= 0.34
    ORDER BY score DESC, listing_count DESC LIMIT $2
    `,
    [trimmed, limit]
  );
}

/** Enregistre une recherche restée sans résultat : matière première des alias (§10). */
export async function logSearchMiss(q: string, locale: Locale, filters: unknown) {
  await query(
    `INSERT INTO search_misses(query, locale, filters) VALUES ($1, $2, $3)`,
    [q.slice(0, 200), locale, JSON.stringify(filters)]
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Requête principale
// ---------------------------------------------------------------------------
export interface PropertyCard {
  id: string;
  reference: string;
  propertyType: string;
  villaSub: string | null;
  floor: number | null;
  bedrooms: number;
  bathrooms: number;
  indoorArea: string | null;
  landArea: string | null;
  titleType: string;
  foreignEligible: boolean;
  furnished: boolean;
  amenities: string[];
  lng: number;
  lat: number;
  locationSlug: string;
  locationName: Record<string, string>;
  parentName: Record<string, string> | null;
  buildingSlug: string | null;
  buildingName: Record<string, string> | null;
  agencyCount: number;
  listingCount: number;
  priceMin: string;
  priceMax: string;
  lastConfirmed: string;
  featured: boolean;
  photo: string | null;
  total: number;
}

function buildWhere(f: Filters, params: unknown[]): string {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };

  if (f.locationSlug) {
    // Descente récursive : choisir « Phnom Penh » englobe tous ses khan et sangkat.
    add(
      `p.location_id IN (
         WITH RECURSIVE tree AS (
           SELECT id FROM locations WHERE slug = $?
           UNION ALL SELECT c.id FROM locations c JOIN tree ON c.parent_id = tree.id
         ) SELECT id FROM tree)`,
      f.locationSlug
    );
  }
  if (f.buildingSlug) add(`p.building_id = (SELECT id FROM buildings WHERE slug = $?)`, f.buildingSlug);
  if (f.types.length) add(`p.property_type = ANY($?::property_type[])`, f.types);
  if (f.bedsMin !== null) add(`p.bedrooms >= $?`, f.bedsMin);
  if (f.bathsMin !== null) add(`p.bathrooms >= $?`, f.bathsMin);
  if (f.areaMin !== null) add(`COALESCE(p.indoor_area_sqm, p.land_area_sqm) >= $?`, f.areaMin);
  if (f.floorMin !== null) add(`p.floor >= $?`, f.floorMin);
  if (f.titles.length) add(`p.title_type = ANY($?::title_type[])`, f.titles);
  if (f.foreignEligible) clauses.push(`p.foreign_eligible`);
  if (f.furnished) clauses.push(`p.furnished`);
  if (f.amenities.length) add(`p.amenities @> $?::text[]`, f.amenities);
  if (f.bbox) {
    params.push(f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3]);
    const n = params.length;
    clauses.push(
      `p.geo_point && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)`
    );
  }
  if (f.polygon && f.polygon.length >= 3) {
    const ring = [...f.polygon, f.polygon[0]];
    const wkt = `POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(",")}))`;
    add(`ST_Within(p.geo_point, ST_SetSRID(ST_GeomFromText($?), 4326))`, wkt);
  }
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

function buildListingWhere(f: Filters, params: unknown[]): string {
  const clauses: string[] = [`l.status = 'active'`];
  params.push(f.transaction);
  clauses.push(`l.transaction_type = $${params.length}::transaction_type`);
  if (f.priceMin !== null) { params.push(f.priceMin); clauses.push(`l.price_usd >= $${params.length}`); }
  if (f.priceMax !== null) { params.push(f.priceMax); clauses.push(`l.price_usd <= $${params.length}`); }
  if (f.confirmedWithin !== null) {
    params.push(f.confirmedWithin);
    clauses.push(`l.last_confirmed_at > now() - ($${params.length} || ' days')::interval`);
  }
  return clauses.join(" AND ");
}

// Les colonnes triées viennent de la CTE `matched`, aliasée `m` dans la
// requête finale.
const ORDER: Record<Sort, string> = {
  relevance: `m.featured DESC, m.agency_count DESC, m.last_confirmed DESC`,
  price_asc: `m.price_min ASC`,
  price_desc: `m.price_max DESC`,
  freshest: `m.last_confirmed DESC`,
  area_desc: `COALESCE(m.indoor_area_sqm, m.land_area_sqm) DESC NULLS LAST`,
};

export async function searchProperties(f: Filters): Promise<{ rows: PropertyCard[]; total: number }> {
  const params: unknown[] = [];
  const listingWhere = buildListingWhere(f, params);
  const propWhere = buildWhere(f, params);
  params.push(PAGE_SIZE, (f.page - 1) * PAGE_SIZE);
  const limitIdx = params.length - 1, offsetIdx = params.length;

  const rows = await query<PropertyCard>(
    `
    WITH agg AS (
      SELECT l.property_id,
             count(*)::int                    AS listing_count,
             count(DISTINCT l.agency_id)::int AS agency_count,
             min(l.price_usd)                 AS price_min,
             max(l.price_usd)                 AS price_max,
             max(l.last_confirmed_at)         AS last_confirmed,
             bool_or(l.featured)              AS featured
      FROM listings l WHERE ${listingWhere}
      GROUP BY l.property_id
    ),
    matched AS (
      SELECT p.*, agg.*
      FROM properties p JOIN agg ON agg.property_id = p.id
      WHERE true ${propWhere}
    )
    SELECT
      m.id, m.reference, m.property_type AS "propertyType", m.villa_sub AS "villaSub",
      m.floor, m.bedrooms, m.bathrooms,
      m.indoor_area_sqm AS "indoorArea", m.land_area_sqm AS "landArea",
      m.title_type AS "titleType", m.foreign_eligible AS "foreignEligible",
      m.furnished, m.amenities,
      ST_X(m.geo_point) AS lng, ST_Y(m.geo_point) AS lat,
      loc.slug AS "locationSlug", loc.name_i18n AS "locationName",
      parent.name_i18n AS "parentName",
      b.slug AS "buildingSlug", b.name_i18n AS "buildingName",
      m.agency_count AS "agencyCount", m.listing_count AS "listingCount",
      m.price_min AS "priceMin", m.price_max AS "priceMax",
      m.last_confirmed AS "lastConfirmed", m.featured,
      (SELECT url FROM media WHERE property_id = m.id ORDER BY position LIMIT 1) AS photo,
      count(*) OVER () AS total
    FROM matched m
    JOIN locations loc ON loc.id = m.location_id
    LEFT JOIN locations parent ON parent.id = loc.parent_id
    LEFT JOIN buildings b ON b.id = m.building_id
    ORDER BY ${ORDER[f.sort]}, m.reference
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `,
    params
  );

  return { rows, total: rows.length ? Number(rows[0].total) : 0 };
}

/** Points pour la carte — allégés, plafonnés, clusterisés côté client. */
export async function searchMapPoints(f: Filters, limit = 2000) {
  const params: unknown[] = [];
  const listingWhere = buildListingWhere(f, params);
  const propWhere = buildWhere(f, params);
  params.push(limit);

  return query<{
    id: string; reference: string; lng: number; lat: number;
    price: string; type: string; beds: number; agencies: number;
  }>(
    `
    WITH agg AS (
      SELECT l.property_id, min(l.price_usd) AS price,
             count(DISTINCT l.agency_id)::int AS agencies
      FROM listings l WHERE ${listingWhere} GROUP BY l.property_id
    )
    SELECT p.id, p.reference, ST_X(p.geo_point) AS lng, ST_Y(p.geo_point) AS lat,
           agg.price, p.property_type AS type, p.bedrooms AS beds, agg.agencies
    FROM properties p JOIN agg ON agg.property_id = p.id
    WHERE true ${propWhere}
    LIMIT $${params.length}
    `,
    params
  );
}

// ---------------------------------------------------------------------------
// Fiche bien
// ---------------------------------------------------------------------------
export interface PropertyDetail {
  id: string;
  reference: string;
  propertyType: string;
  villaSub: string | null;
  floor: number | null;
  unitNumber: string | null;
  bedrooms: number;
  bathrooms: number;
  indoorArea: string | null;
  landArea: string | null;
  titleType: string;
  foreignEligible: boolean;
  yearBuilt: number | null;
  furnished: boolean | null;
  amenities: string[];
  verifiedAt: string | null;
  geoPinBy: string | null;
  geoPinAt: string | null;
  lng: number;
  lat: number;
  locationSlug: string;
  locationName: Record<string, string>;
  parentSlug: string | null;
  parentName: Record<string, string> | null;
  buildingSlug: string | null;
  buildingName: Record<string, string> | null;
  buildingFloors: number | null;
  buildingUnits: number | null;
  buildingYear: number | null;
  buildingStatus: string | null;
  buildingAmenities: string[] | null;
  developerName: string | null;
}

export interface OfferDetail {
  id: string;
  transactionType: string;
  price: string;
  pricePeriod: string | null;
  negotiable: boolean | null;
  source: string;
  lastConfirmed: string;
  expiresAt: string;
  description: Record<string, string> | null;
  sourceLang: string;
  machineTranslated: boolean | null;
  featured: boolean;
  agencyId: string;
  agencySlug: string;
  agencyName: string;
  agencyVerification: string;
  agencyTier: string;
  agentId: string;
  agentName: string;
  phone: string;
  telegram: string | null;
  wechat: string | null;
  spokenLangs: string[] | null;
  history: { price: string; at: string }[] | null;
}

export async function getProperty(reference: string) {
  const property = await queryOne<PropertyDetail>(
    `
    SELECT p.id, p.reference, p.property_type AS "propertyType", p.villa_sub AS "villaSub",
           p.floor, p.unit_number AS "unitNumber", p.bedrooms, p.bathrooms,
           p.indoor_area_sqm AS "indoorArea", p.land_area_sqm AS "landArea",
           p.title_type AS "titleType", p.foreign_eligible AS "foreignEligible",
           p.year_built AS "yearBuilt", p.furnished, p.amenities,
           p.verified_at AS "verifiedAt", p.geo_pin_by AS "geoPinBy", p.geo_pin_at AS "geoPinAt",
           ST_X(p.geo_point) AS lng, ST_Y(p.geo_point) AS lat,
           loc.slug AS "locationSlug", loc.name_i18n AS "locationName",
           parent.slug AS "parentSlug", parent.name_i18n AS "parentName",
           b.slug AS "buildingSlug", b.name_i18n AS "buildingName",
           b.total_floors AS "buildingFloors", b.total_units AS "buildingUnits",
           b.completion_year AS "buildingYear", b.status AS "buildingStatus",
           b.amenities AS "buildingAmenities", d.name AS "developerName"
    FROM properties p
    JOIN locations loc ON loc.id = p.location_id
    LEFT JOIN locations parent ON parent.id = loc.parent_id
    LEFT JOIN buildings b ON b.id = p.building_id
    LEFT JOIN developers d ON d.id = b.developer_id
    WHERE p.reference = $1
    `,
    [reference]
  );
  if (!property) return null;

  // Toutes les offres actives sur ce bien : le cœur de la fiche (§3.3).
  const offers = await query<OfferDetail>(
    `
    SELECT l.id, l.transaction_type AS "transactionType", l.price_usd AS "price",
           l.price_period AS "pricePeriod", l.negotiable, l.source,
           l.last_confirmed_at AS "lastConfirmed", l.expires_at AS "expiresAt",
           l.description_i18n AS "description", l.description_source_lang AS "sourceLang",
           l.machine_translated AS "machineTranslated", l.featured,
           a.id AS "agencyId", a.slug AS "agencySlug", a.name AS "agencyName",
           a.verification_status AS "agencyVerification", a.subscription_tier AS "agencyTier",
           ag.id AS "agentId", ag.name AS "agentName", ag.phone, ag.telegram, ag.wechat,
           -- node-pg ne sait pas décoder un tableau d'enum : cast explicite.
           ag.spoken_langs::text[] AS "spokenLangs",
           (SELECT json_agg(json_build_object('price', ph.price_usd, 'at', ph.recorded_at)
                            ORDER BY ph.recorded_at)
            FROM price_history ph WHERE ph.listing_id = l.id) AS history
    FROM listings l
    JOIN agencies a ON a.id = l.agency_id
    JOIN agents ag ON ag.id = l.agent_id
    WHERE l.property_id = $1 AND l.status = 'active'
    ORDER BY l.featured DESC, l.price_usd ASC
    `,
    [property.id]
  );

  const photos = await query<{ url: string; width: number; height: number }>(
    `SELECT url, width, height FROM media WHERE property_id = $1 ORDER BY position`,
    [property.id]
  );

  return { property, offers, photos };
}

/** Biens comparables : même quartier, même type, surface proche. */
export async function similarProperties(propertyId: string, limit = 4) {
  return query<PropertyCard>(
    `
    WITH ref AS (SELECT * FROM properties WHERE id = $1),
    agg AS (
      SELECT l.property_id, min(l.price_usd) AS price_min, max(l.price_usd) AS price_max,
             count(DISTINCT l.agency_id)::int AS agency_count,
             max(l.last_confirmed_at) AS last_confirmed
      FROM listings l WHERE l.status = 'active' GROUP BY l.property_id
    )
    SELECT p.id, p.reference, p.property_type AS "propertyType", p.bedrooms, p.bathrooms,
           p.indoor_area_sqm AS "indoorArea", p.land_area_sqm AS "landArea",
           p.foreign_eligible AS "foreignEligible", p.floor,
           ST_X(p.geo_point) AS lng, ST_Y(p.geo_point) AS lat,
           loc.slug AS "locationSlug", loc.name_i18n AS "locationName",
           agg.price_min AS "priceMin", agg.price_max AS "priceMax",
           agg.agency_count AS "agencyCount", agg.last_confirmed AS "lastConfirmed",
           (SELECT url FROM media WHERE property_id = p.id ORDER BY position LIMIT 1) AS photo
    FROM properties p
    JOIN agg ON agg.property_id = p.id
    JOIN locations loc ON loc.id = p.location_id
    CROSS JOIN ref
    WHERE p.id <> ref.id AND p.location_id = ref.location_id
      AND p.property_type = ref.property_type
    ORDER BY abs(COALESCE(p.indoor_area_sqm, p.land_area_sqm, 0)
                 - COALESCE(ref.indoor_area_sqm, ref.land_area_sqm, 0))
    LIMIT $2
    `,
    [propertyId, limit]
  );
}
