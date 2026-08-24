import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { pool, query, queryOne } from "./db";
import { PROPERTY_TYPES } from "./search";
// Clés, authentification et quota en ESM simple, partagés avec le
// back-office et les scripts de contrôle.
import { authenticateApiKey, consumeApiQuota } from "../../db/lib/partner-api.mjs";

/**
 * API partenaires (phase 4) — contrat v1.
 *
 * Lecture seule, versionnée dans l'URL (`/api/partner/v1/`), réponses en
 * snake_case : le contrat public est indépendant des conventions internes,
 * et v1 n'évolue que par ajout de champs — jamais par retrait ni renommage.
 *
 * Ce que l'API ne transporte pas, à dessein :
 * - les coordonnées des agents : le contact est l'événement facturable du
 *   portail (§8), il ne sort pas en gros ;
 * - des Listing isolés : la fiche servie est le Property agrégé (§3.3),
 *   c'est la donnée dédupliquée qui a de la valeur.
 */

// ---------------------------------------------------------------------------
// Authentification, quota, enveloppe des réponses
// ---------------------------------------------------------------------------

export interface PartnerContext {
  keyId: string;
  partnerId: string;
  partnerSlug: string;
  partnerName: string;
  dailyQuota: number;
  remaining: number;
}

function apiError(status: number, code: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: code }, { status, headers });
}

/** Secondes jusqu'à minuit UTC : le quota journalier se remet à zéro là. */
function secondsUntilReset(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000));
}

function rateHeaders(quota: number, remaining: number): Record<string, string> {
  return {
    "x-ratelimit-limit": String(quota),
    "x-ratelimit-remaining": String(Math.max(0, remaining)),
    "x-ratelimit-reset": String(secondsUntilReset()),
  };
}

/**
 * Garde d'entrée de toutes les routes partenaires : clé, état, quota.
 *
 * La clé passe par `Authorization: Bearer …` (ou `X-Api-Key`), jamais par
 * l'URL — une URL finit dans les journaux d'accès et l'historique des
 * navigateurs. Une clé inconnue vaut 401, une clé fermée 403 : le
 * partenaire dont la clé vient d'être révoquée doit comprendre pourquoi
 * ses appels échouent, pas croire à une faute de frappe.
 */
export async function withPartner(
  request: NextRequest,
  handler: (ctx: PartnerContext) => Promise<NextResponse>
): Promise<NextResponse> {
  const auth = request.headers.get("authorization");
  const raw = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : request.headers.get("x-api-key")?.trim();
  if (!raw) return apiError(401, "missing_key");

  const key = await authenticateApiKey(pool, raw);
  if (!key) return apiError(401, "unknown_key");
  if (!key.ok) return apiError(403, key.reason ?? "forbidden");

  const remaining: number | null = await consumeApiQuota(pool, key.keyId);
  // Clé supprimée entre l'authentification et le décompte : traitée comme inconnue.
  if (remaining === null) return apiError(401, "unknown_key");
  const headers = rateHeaders(key.dailyQuota, remaining);
  if (remaining < 0) return apiError(429, "quota_exceeded", headers);

  const response = await handler({ ...key, remaining } as PartnerContext);
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  // Chaque réponse est décomptée d'un quota propre à la clé : rien à cacher.
  response.headers.set("cache-control", "no-store");
  return response;
}

// ---------------------------------------------------------------------------
// Filtres de la liste
// ---------------------------------------------------------------------------

export interface PartnerFilters {
  transaction: "sale" | "rent" | null;
  types: string[];
  locationSlug: string | null;
  foreignEligible: boolean;
  priceMin: number | null;
  priceMax: number | null;
  updatedSince: string | null; // ISO 8601
  limit: number;
  cursor: string | null; // dernière référence de la page précédente
}

export const PARTNER_PAGE_MAX = 100;

/**
 * Valide les paramètres de la liste. Contrairement à la recherche du site —
 * qui ignore silencieusement ce qu'elle ne comprend pas pour ne jamais
 * casser une URL partagée — une API répond 400 avec le paramètre fautif :
 * un filtre ignoré sans bruit ferait croire au partenaire que son
 * intégration fonctionne alors qu'elle ramène tout le catalogue.
 */
export function parsePartnerFilters(
  sp: URLSearchParams
): { ok: PartnerFilters } | { error: string } {
  const transaction = sp.get("transaction");
  if (transaction && transaction !== "sale" && transaction !== "rent") {
    return { error: "transaction" };
  }

  const types = sp.getAll("type");
  for (const t of types) {
    if (!(PROPERTY_TYPES as readonly string[]).includes(t)) return { error: "type" };
  }

  const num = (name: string): number | null | false => {
    const v = sp.get(name);
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : false;
  };
  const priceMin = num("price_min");
  const priceMax = num("price_max");
  if (priceMin === false) return { error: "price_min" };
  if (priceMax === false) return { error: "price_max" };
  // Les bornes de prix portent sur le meilleur prix affiché d'une offre :
  // sans type de transaction, comparer 1 200 $/mois à 145 000 $ n'a pas de sens.
  if ((priceMin !== null || priceMax !== null) && !transaction) {
    return { error: "price_requires_transaction" };
  }

  const updatedSince = sp.get("updated_since");
  if (updatedSince && Number.isNaN(Date.parse(updatedSince))) {
    return { error: "updated_since" };
  }

  const limitRaw = sp.get("limit");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PARTNER_PAGE_MAX) {
    return { error: "limit" };
  }

  return {
    ok: {
      transaction: (transaction as "sale" | "rent") ?? null,
      types,
      locationSlug: sp.get("location")?.trim() || null,
      foreignEligible: sp.get("foreign_eligible") === "1",
      priceMin,
      priceMax,
      updatedSince: updatedSince || null,
      limit,
      cursor: sp.get("cursor")?.trim() || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Sérialisation publique
// ---------------------------------------------------------------------------

interface PropertyRow {
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
  yearBuilt: number | null;
  amenities: string[];
  lng: number;
  lat: number;
  locationSlug: string;
  locationLevel: string;
  locationName: Record<string, string>;
  parentSlug: string | null;
  parentName: Record<string, string> | null;
  buildingSlug: string | null;
  buildingName: Record<string, string> | null;
  titleVerifiedAt: string | null;
  titleVerifiedBy: string | null;
  offers: unknown[];
  updatedAt: string;
}

const toNumber = (v: string | null) => (v === null ? null : Number(v));
const toIso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

function toPublicProperty(r: PropertyRow) {
  return {
    reference: r.reference,
    property_type: r.propertyType,
    villa_subtype: r.villaSub,
    floor: r.floor,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    indoor_area_sqm: toNumber(r.indoorArea),
    land_area_sqm: toNumber(r.landArea),
    title_type: r.titleType,
    foreign_eligible: r.foreignEligible,
    furnished: r.furnished,
    year_built: r.yearBuilt,
    amenities: r.amenities,
    geo: { lng: r.lng, lat: r.lat },
    location: {
      slug: r.locationSlug,
      level: r.locationLevel,
      name: r.locationName,
      parent: r.parentSlug ? { slug: r.parentSlug, name: r.parentName } : null,
    },
    building: r.buildingSlug ? { slug: r.buildingSlug, name: r.buildingName } : null,
    title_verified: r.titleVerifiedAt
      ? { at: toIso(r.titleVerifiedAt), by: r.titleVerifiedBy }
      : null,
    offers: r.offers,
    updated_at: toIso(r.updatedAt),
  };
}

// Offres actives agrégées par bien et type de transaction (§3.3), plus la
// date de dernier mouvement — celle du bien ou de ses annonces, la plus
// récente — qui alimente `updated_since` pour les synchronisations.
const OFFERS_CTE = `
  agg AS (
    SELECT l.property_id, l.transaction_type,
           count(*)::int                    AS listing_count,
           count(DISTINCT l.agency_id)::int AS agency_count,
           min(l.price_usd)                 AS price_min,
           max(l.price_usd)                 AS price_max,
           max(l.last_confirmed_at)         AS last_confirmed,
           max(l.updated_at)                AS updated_at
    FROM listings l WHERE l.status = 'active'
    GROUP BY l.property_id, l.transaction_type
  ),
  offers AS (
    SELECT property_id,
           jsonb_agg(jsonb_build_object(
             'transaction_type', transaction_type,
             'listing_count', listing_count,
             'agency_count', agency_count,
             'price_min_usd', price_min,
             'price_max_usd', price_max,
             'last_confirmed_at', last_confirmed) ORDER BY transaction_type) AS offers,
           max(updated_at) AS updated_at
    FROM agg GROUP BY property_id
  )`;

const PROPERTY_COLUMNS = `
  p.reference, p.property_type AS "propertyType", p.villa_sub AS "villaSub",
  p.floor, p.bedrooms, p.bathrooms,
  p.indoor_area_sqm AS "indoorArea", p.land_area_sqm AS "landArea",
  p.title_type AS "titleType", p.foreign_eligible AS "foreignEligible",
  p.furnished, p.year_built AS "yearBuilt", p.amenities,
  ST_X(p.geo_point) AS lng, ST_Y(p.geo_point) AS lat,
  loc.slug AS "locationSlug", loc.level::text AS "locationLevel",
  loc.name_i18n AS "locationName",
  parent.slug AS "parentSlug", parent.name_i18n AS "parentName",
  b.slug AS "buildingSlug", b.name_i18n AS "buildingName",
  p.title_verified_at AS "titleVerifiedAt", p.title_verified_by AS "titleVerifiedBy",
  o.offers, GREATEST(p.updated_at, o.updated_at) AS "updatedAt"`;

const PROPERTY_JOINS = `
  FROM properties p
  JOIN offers o ON o.property_id = p.id
  JOIN locations loc ON loc.id = p.location_id
  LEFT JOIN locations parent ON parent.id = loc.parent_id
  LEFT JOIN buildings b ON b.id = p.building_id`;

/**
 * Liste paginée par jeu de clés sur la référence — stable sous insertions,
 * contrairement à un OFFSET qui ferait sauter ou doubler des biens entre
 * deux pages d'une synchronisation.
 */
export async function listPartnerProperties(
  f: PartnerFilters
): Promise<{ data: ReturnType<typeof toPublicProperty>[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const clauses: string[] = ["true"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };

  if (f.transaction) {
    // Les bornes de prix s'appliquent au meilleur prix affiché (le minimum
    // des annonces actives) : c'est celui que la fiche publique met en avant.
    params.push(f.transaction);
    const t = params.length;
    let priceSql = "";
    if (f.priceMin !== null) { params.push(f.priceMin); priceSql += ` AND a.price_min >= $${params.length}`; }
    if (f.priceMax !== null) { params.push(f.priceMax); priceSql += ` AND a.price_min <= $${params.length}`; }
    clauses.push(`EXISTS (SELECT 1 FROM agg a
      WHERE a.property_id = p.id AND a.transaction_type = $${t}::transaction_type${priceSql})`);
  }
  if (f.types.length) add(`p.property_type = ANY($?::property_type[])`, f.types);
  if (f.locationSlug) {
    // Descente récursive, comme la recherche du site : « Phnom Penh »
    // englobe tous ses khan et sangkat.
    add(
      `p.location_id IN (
         WITH RECURSIVE tree AS (
           SELECT id FROM locations WHERE slug = $?
           UNION ALL SELECT c.id FROM locations c JOIN tree ON c.parent_id = tree.id
         ) SELECT id FROM tree)`,
      f.locationSlug
    );
  }
  if (f.foreignEligible) clauses.push(`p.foreign_eligible`);
  if (f.updatedSince) add(`GREATEST(p.updated_at, o.updated_at) >= $?::timestamptz`, f.updatedSince);
  if (f.cursor) add(`p.reference > $?`, f.cursor);

  params.push(f.limit + 1);
  const rows = await query<PropertyRow>(
    `WITH ${OFFERS_CTE}
     SELECT ${PROPERTY_COLUMNS}
     ${PROPERTY_JOINS}
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.reference
     LIMIT $${params.length}`,
    params
  );

  const page = rows.slice(0, f.limit);
  return {
    data: page.map(toPublicProperty),
    nextCursor: rows.length > f.limit ? page[page.length - 1].reference : null,
  };
}

/**
 * Fiche complète d'un bien : la fiche agrégée, plus le détail des annonces
 * actives (agence, prix, description) et les médias. L'agent n'y figure
 * pas — seule l'agence, qui est une information publique de la fiche.
 */
export async function getPartnerProperty(reference: string) {
  const row = await queryOne<PropertyRow & { id: string }>(
    `WITH ${OFFERS_CTE}
     SELECT p.id, ${PROPERTY_COLUMNS}
     ${PROPERTY_JOINS}
     WHERE p.reference = $1`,
    [reference]
  );
  if (!row) return null;

  const [listings, media] = await Promise.all([
    query<{
      transaction: string; price: string; period: string; negotiable: boolean;
      lastConfirmed: string; description: Record<string, string>;
      sourceLang: string; machine: boolean;
      agencySlug: string; agencyName: string; agencyVerification: string;
    }>(
      `SELECT l.transaction_type AS transaction, l.price_usd AS price,
              l.price_period AS period, l.negotiable,
              l.last_confirmed_at AS "lastConfirmed",
              l.description_i18n AS description,
              l.description_source_lang AS "sourceLang",
              l.machine_translated AS machine,
              a.slug AS "agencySlug", a.name AS "agencyName",
              a.verification_status AS "agencyVerification"
       FROM listings l JOIN agencies a ON a.id = l.agency_id
       WHERE l.property_id = $1 AND l.status = 'active'
       ORDER BY l.price_usd, a.slug`,
      [row.id]
    ),
    query<{ url: string; width: number | null; height: number | null }>(
      `SELECT url, width, height FROM media
       WHERE property_id = $1 ORDER BY position`,
      [row.id]
    ),
  ]);

  return {
    ...toPublicProperty(row),
    listings: listings.map((l) => ({
      transaction_type: l.transaction,
      price_usd: Number(l.price),
      price_period: l.period,
      negotiable: l.negotiable,
      last_confirmed_at: toIso(l.lastConfirmed),
      description: l.description,
      description_source_lang: l.sourceLang,
      machine_translated: l.machine,
      agency: {
        slug: l.agencySlug,
        name: l.agencyName,
        verification_status: l.agencyVerification,
      },
    })),
    media,
  };
}

/**
 * Référentiel des localités : hiérarchie complète, alias de romanisation
 * compris (§5.2) — c'est la table de correspondance dont un partenaire a
 * besoin pour mapper ses propres libellés vers les slugs du portail.
 */
export async function listPartnerLocations() {
  const rows = await query<{
    slug: string; level: string; name: Record<string, string>;
    aliases: string[]; parentSlug: string | null;
    lng: number; lat: number; listingCount: number;
  }>(
    `SELECT l.slug, l.level::text AS level, l.name_i18n AS name, l.aliases,
            p.slug AS "parentSlug",
            ST_X(l.geo_center) AS lng, ST_Y(l.geo_center) AS lat,
            l.listing_count AS "listingCount"
     FROM locations l LEFT JOIN locations p ON p.id = l.parent_id
     ORDER BY l.level, l.slug`
  );
  return rows.map((r) => ({
    slug: r.slug,
    level: r.level,
    name: r.name,
    aliases: r.aliases,
    parent_slug: r.parentSlug,
    geo_center: { lng: r.lng, lat: r.lat },
    listing_count: r.listingCount,
  }));
}
