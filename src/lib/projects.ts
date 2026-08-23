import "server-only";
import { query, queryOne } from "./db";
import type { PropertyCard } from "./search";

/**
 * Pages promoteurs et projets neufs (phase 3).
 *
 * Les immeubles et boreys sont peu nombreux et riches en attributs propres
 * (étages, unités, année, statut, promoteur) : chaque page a un contenu
 * distinct même sans annonce active. Contrairement aux pages d'atterrissage
 * quartier × type, il n'y a donc pas de seuil d'indexation — un projet en
 * construction sans annonce est précisément ce qu'un acheteur sur plan
 * cherche.
 */

export interface ProjectSummary {
  slug: string;
  name: Record<string, string>;
  status: "planned" | "under_construction" | "completed";
  totalFloors: number | null;
  totalUnits: number | null;
  completionYear: number | null;
  locationSlug: string;
  locationName: Record<string, string>;
  parentName: Record<string, string> | null;
  developerSlug: string | null;
  developerName: string | null;
  properties: number;
  listings: number;
  priceMin: string | null;
  priceMax: string | null;
}

const PROJECT_SUMMARY_SELECT = `
  SELECT b.slug, b.name_i18n AS name, b.status::text AS status,
         b.total_floors AS "totalFloors", b.total_units AS "totalUnits",
         b.completion_year AS "completionYear",
         loc.slug AS "locationSlug", loc.name_i18n AS "locationName",
         parent.name_i18n AS "parentName",
         d.slug AS "developerSlug", d.name AS "developerName",
         COALESCE(s.properties, 0) AS properties,
         COALESCE(s.listings, 0) AS listings,
         s.price_min AS "priceMin", s.price_max AS "priceMax"
  FROM buildings b
  JOIN locations loc ON loc.id = b.location_id
  LEFT JOIN locations parent ON parent.id = loc.parent_id
  LEFT JOIN developers d ON d.id = b.developer_id
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT p.id)::int AS properties, count(*)::int AS listings,
           min(l.price_usd) AS price_min, max(l.price_usd) AS price_max
    FROM properties p
    JOIN listings l ON l.property_id = p.id AND l.status = 'active'
    WHERE p.building_id = b.id
  ) s ON true
`;

/** Tous les projets, les chantiers d'abord — la page hub « projets neufs ». */
export async function listProjects(): Promise<ProjectSummary[]> {
  return query<ProjectSummary>(
    `${PROJECT_SUMMARY_SELECT}
     ORDER BY b.status <> 'completed' DESC, COALESCE(s.listings, 0) DESC,
              b.completion_year DESC NULLS LAST`
  );
}

export interface ProjectDetail extends ProjectSummary {
  id: string;
  amenities: string[];
  lng: number;
  lat: number;
  parentSlug: string | null;
  developerCountry: string | null;
  agencies: number;
  saleMin: string | null;
  saleMax: string | null;
  rentMin: string | null;
  rentMax: string | null;
  freshWithin30: number;
}

export async function getProject(slug: string): Promise<ProjectDetail | null> {
  return queryOne<ProjectDetail>(
    `
    SELECT b.id, b.slug, b.name_i18n AS name, b.status::text AS status,
           b.total_floors AS "totalFloors", b.total_units AS "totalUnits",
           b.completion_year AS "completionYear", b.amenities,
           ST_X(b.geo_point) AS lng, ST_Y(b.geo_point) AS lat,
           loc.slug AS "locationSlug", loc.name_i18n AS "locationName",
           parent.slug AS "parentSlug", parent.name_i18n AS "parentName",
           d.slug AS "developerSlug", d.name AS "developerName", d.country AS "developerCountry",
           COALESCE(s.properties, 0) AS properties,
           COALESCE(s.listings, 0) AS listings,
           COALESCE(s.agencies, 0) AS agencies,
           s.price_min AS "priceMin", s.price_max AS "priceMax",
           s.sale_min AS "saleMin", s.sale_max AS "saleMax",
           s.rent_min AS "rentMin", s.rent_max AS "rentMax",
           COALESCE(s.fresh_30, 0) AS "freshWithin30"
    FROM buildings b
    JOIN locations loc ON loc.id = b.location_id
    LEFT JOIN locations parent ON parent.id = loc.parent_id
    LEFT JOIN developers d ON d.id = b.developer_id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT p.id)::int AS properties, count(*)::int AS listings,
             count(DISTINCT l.agency_id)::int AS agencies,
             min(l.price_usd) AS price_min, max(l.price_usd) AS price_max,
             min(l.price_usd) FILTER (WHERE l.transaction_type = 'sale') AS sale_min,
             max(l.price_usd) FILTER (WHERE l.transaction_type = 'sale') AS sale_max,
             min(l.price_usd) FILTER (WHERE l.transaction_type = 'rent') AS rent_min,
             max(l.price_usd) FILTER (WHERE l.transaction_type = 'rent') AS rent_max,
             count(DISTINCT p.id) FILTER
               (WHERE l.last_confirmed_at > now() - interval '30 days')::int AS fresh_30
      FROM properties p
      JOIN listings l ON l.property_id = p.id AND l.status = 'active'
      WHERE p.building_id = b.id
    ) s ON true
    WHERE b.slug = $1
    `,
    [slug]
  );
}

/** Biens à annonces actives dans le projet, pour la grille de la fiche. */
export async function projectProperties(buildingId: string, limit = 24): Promise<PropertyCard[]> {
  return query<PropertyCard>(
    `
    WITH agg AS (
      SELECT l.property_id, min(l.price_usd) AS price_min, max(l.price_usd) AS price_max,
             count(DISTINCT l.agency_id)::int AS agency_count, count(*)::int AS listing_count,
             max(l.last_confirmed_at) AS last_confirmed, bool_or(l.featured) AS featured
      FROM listings l WHERE l.status = 'active' GROUP BY l.property_id
    )
    SELECT p.id, p.reference, p.property_type AS "propertyType", p.villa_sub AS "villaSub",
           p.floor, p.bedrooms, p.bathrooms,
           p.indoor_area_sqm AS "indoorArea", p.land_area_sqm AS "landArea",
           p.title_type AS "titleType", p.foreign_eligible AS "foreignEligible",
           p.furnished, p.amenities, ST_X(p.geo_point) AS lng, ST_Y(p.geo_point) AS lat,
           loc.slug AS "locationSlug", loc.name_i18n AS "locationName",
           parent.name_i18n AS "parentName",
           b.slug AS "buildingSlug", b.name_i18n AS "buildingName",
           agg.agency_count AS "agencyCount", agg.listing_count AS "listingCount",
           agg.price_min AS "priceMin", agg.price_max AS "priceMax",
           agg.last_confirmed AS "lastConfirmed", agg.featured,
           (SELECT url FROM media WHERE property_id = p.id ORDER BY position LIMIT 1) AS photo
    FROM properties p
    JOIN agg ON agg.property_id = p.id
    JOIN locations loc ON loc.id = p.location_id
    LEFT JOIN locations parent ON parent.id = loc.parent_id
    LEFT JOIN buildings b ON b.id = p.building_id
    WHERE p.building_id = $1
    ORDER BY agg.featured DESC, agg.last_confirmed DESC
    LIMIT $2
    `,
    [buildingId, limit]
  );
}

export interface DeveloperSummary {
  slug: string;
  name: string;
  country: string | null;
  projects: number;
  totalUnits: number;
  listings: number;
}

export async function listDevelopers(): Promise<DeveloperSummary[]> {
  return query<DeveloperSummary>(
    `
    SELECT d.slug, d.name, d.country,
           count(b.id)::int AS projects,
           COALESCE(sum(b.total_units), 0)::int AS "totalUnits",
           COALESCE((
             SELECT count(*) FROM listings l
             JOIN properties p ON p.id = l.property_id
             JOIN buildings bb ON bb.id = p.building_id
             WHERE bb.developer_id = d.id AND l.status = 'active'
           ), 0)::int AS listings
    FROM developers d
    LEFT JOIN buildings b ON b.developer_id = d.id
    GROUP BY d.id
    HAVING count(b.id) > 0
    ORDER BY count(b.id) DESC, d.name
    `
  );
}

export interface DeveloperDetail {
  slug: string;
  name: string;
  country: string | null;
  createdAt: string;
}

export async function getDeveloper(slug: string) {
  const developer = await queryOne<DeveloperDetail>(
    `SELECT slug, name, country, created_at AS "createdAt" FROM developers WHERE slug = $1`,
    [slug]
  );
  if (!developer) return null;

  const projects = await query<ProjectSummary>(
    `${PROJECT_SUMMARY_SELECT}
     WHERE d.slug = $1
     ORDER BY b.status <> 'completed' DESC, b.completion_year DESC NULLS LAST`,
    [slug]
  );
  return { developer, projects };
}
