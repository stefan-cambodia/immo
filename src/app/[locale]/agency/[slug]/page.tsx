import Link from "next/link";
import { notFound } from "next/navigation";
import { query, queryOne } from "@/lib/db";
import { formatDate, formatNumber } from "@/lib/format";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { PropertyGrid } from "@/components/PropertyCard";
import type { PropertyCard } from "@/lib/search";

export const revalidate = 300;

export default async function AgencyPage({
  params,
}: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const agency = await queryOne<{
    id: string; name: string; verification: string; tier: string;
    quota: number; createdAt: string; active: string; leads30: string;
  }>(
    `SELECT a.id, a.name, a.verification_status AS verification, a.subscription_tier AS tier,
            a.listing_quota AS quota, a.created_at AS "createdAt",
            (SELECT count(*) FROM listings l WHERE l.agency_id = a.id AND l.status='active') AS active,
            (SELECT count(*) FROM leads le WHERE le.agency_id = a.id
               AND le.created_at > now() - interval '30 days') AS leads30
     FROM agencies a WHERE a.slug = $1`,
    [slug]
  );
  if (!agency) notFound();

  const rows = await query<PropertyCard>(
    `
    WITH agg AS (
      SELECT l.property_id, min(l.price_usd) AS price_min, max(l.price_usd) AS price_max,
             count(DISTINCT l.agency_id)::int AS agency_count,
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
           agg.agency_count AS "agencyCount", agg.price_min AS "priceMin",
           agg.price_max AS "priceMax", agg.last_confirmed AS "lastConfirmed", agg.featured,
           (SELECT url FROM media WHERE property_id = p.id ORDER BY position LIMIT 1) AS photo,
           (SELECT NULLIF(variants, '[]'::jsonb) FROM media
             WHERE property_id = p.id ORDER BY position LIMIT 1) AS "photoVariants"
    FROM listings l
    JOIN properties p ON p.id = l.property_id
    JOIN agg ON agg.property_id = p.id
    JOIN locations loc ON loc.id = p.location_id
    LEFT JOIN locations parent ON parent.id = loc.parent_id
    LEFT JOIN buildings b ON b.id = p.building_id
    WHERE l.agency_id = $1 AND l.status = 'active'
    GROUP BY p.id, loc.slug, loc.name_i18n, parent.name_i18n, b.slug, b.name_i18n,
             agg.agency_count, agg.price_min, agg.price_max, agg.last_confirmed, agg.featured
    ORDER BY agg.last_confirmed DESC LIMIT 24
    `,
    [agency.id]
  );

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
            {agency.name}
          </h1>
          <span className="chip" style={{
            background: agency.verification === "verified" ? "var(--color-fresh-soft)" : "var(--color-surface-alt)",
            color: agency.verification === "verified" ? "var(--color-fresh)" : "var(--color-ink-soft)",
            whiteSpace: "normal",
          }}>
            {t(`agency.${agency.verification}`)}
          </span>
        </div>
        <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", marginTop: "0.375rem" }}>
          {t("agency.listingsCount", { n: formatNumber(agency.active, locale) })}
          {" · "}
          {t("agency.since", { date: formatDate(agency.createdAt, locale) })}
          {" · "}
          {t("backoffice.leads")} 30 j : {formatNumber(agency.leads30, locale)}
        </p>
      </header>

      {rows.length > 0
        ? <PropertyGrid items={rows} locale={locale} t={t} transaction="sale" />
        : <p style={{ color: "var(--color-ink-soft)" }}>{t("common.noResults")}</p>}

      <p style={{ marginTop: "2rem" }}>
        <Link href={`/${locale}/search`} style={{ color: "var(--color-brand)", fontWeight: 600 }}>
          ← {t("home.browseAll")}
        </Link>
      </p>
    </div>
  );
}
