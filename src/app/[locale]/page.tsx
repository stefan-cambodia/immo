import Link from "next/link";
import { notFound } from "next/navigation";
import { query } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { getTranslator, i18nField, isLocale, type Locale } from "@/lib/i18n";
import { PropertyGrid } from "@/components/PropertyCard";
import { SearchBox } from "@/components/SearchBox";
import { searchProperties, parseFilters } from "@/lib/search";

// Rendu serveur avec revalidation : le SEO multilingue est le canal
// d'acquisition principal (principe n°5).
export const revalidate = 300;

interface Stats {
  properties: string; listings: string; agencies: string; merged: string;
}

export default async function HomePage({
  params,
}: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const [stats] = await query<Stats>(`
    SELECT
      (SELECT count(*) FROM properties p
        WHERE EXISTS (SELECT 1 FROM listings l WHERE l.property_id = p.id AND l.status='active')) AS properties,
      (SELECT count(*) FROM listings WHERE status='active') AS listings,
      (SELECT count(*) FROM agencies) AS agencies,
      (SELECT count(*) FROM listings l WHERE l.status='active'
        AND (SELECT count(DISTINCT agency_id) FROM listings x
             WHERE x.property_id = l.property_id AND x.status='active') > 1) AS merged
  `);

  const areas = await query<{
    slug: string; name: Record<string, string>; parent: Record<string, string> | null; n: number;
  }>(`
    SELECT l.slug, l.name_i18n AS name, p.name_i18n AS parent, l.listing_count AS n
    FROM locations l LEFT JOIN locations p ON p.id = l.parent_id
    WHERE l.level = 'neighborhood' AND l.listing_count > 0
    ORDER BY l.listing_count DESC LIMIT 12
  `);

  const { rows: featured } = await searchProperties(
    parseFilters({ sort: "relevance" })
  );

  const { rows: foreignOk } = await searchProperties(
    parseFilters({ foreign: "1", sort: "freshest" })
  );

  const Stat = ({ value, label }: { value: string | number; label: string }) => (
    <div>
      <div style={{ fontSize: "clamp(1.5rem, 4vw, 2rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
        {formatNumber(value, locale)}
      </div>
      <div style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", lineHeight: 1.4 }}>
        {label}
      </div>
    </div>
  );

  return (
    <>
      <section style={{
        background: "linear-gradient(160deg, var(--color-brand-soft), var(--color-surface) 70%)",
        borderBottom: "1px solid var(--color-line)",
        padding: "clamp(2rem, 7vw, 4.5rem) clamp(0.75rem, 3vw, 1.5rem)",
      }}>
        <div style={{ maxWidth: "48rem", margin: "0 auto", textAlign: "center" }}>
          <h1 style={{
            fontSize: "clamp(1.75rem, 5.5vw, 3rem)", fontWeight: 800,
            letterSpacing: "-0.03em", lineHeight: 1.15, marginBottom: "0.875rem",
          }}>
            {t("home.heroTitle")}
          </h1>
          <p style={{
            fontSize: "clamp(0.9375rem, 2.2vw, 1.125rem)", color: "var(--color-ink-soft)",
            lineHeight: 1.6, marginBottom: "1.75rem", maxWidth: "38rem",
            marginInline: "auto",
          }}>
            {t("home.heroSubtitle")}
          </p>

          <SearchBox locale={locale} placeholder={t("home.searchPlaceholder")} size="lg" />

          <div style={{
            display: "flex", gap: "0.5rem", justifyContent: "center",
            flexWrap: "wrap", marginTop: "1rem",
          }}>
            <Link href={`/${locale}/search`} className="btn btn-outline"
                  style={{ fontSize: "0.8125rem", padding: "0.375rem 0.75rem" }}>
              {t("common.forSale")}
            </Link>
            <Link href={`/${locale}/search?txn=rent`} className="btn btn-outline"
                  style={{ fontSize: "0.8125rem", padding: "0.375rem 0.75rem" }}>
              {t("common.forRent")}
            </Link>
            <Link href={`/${locale}/search?foreign=1`} className="btn btn-outline"
                  style={{
                    fontSize: "0.8125rem", padding: "0.375rem 0.75rem",
                    borderColor: "var(--color-brand)", color: "var(--color-brand)",
                  }}>
              {t("nav.foreignEligible")}
            </Link>
          </div>
        </div>
      </section>

      <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "0 clamp(0.75rem, 3vw, 1.5rem)" }}>
        <section style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
          gap: "1.5rem", padding: "2rem 0", borderBottom: "1px solid var(--color-line-soft)",
        }}>
          <Stat value={stats.properties} label={t("home.statProperties")} />
          <Stat value={stats.listings} label={t("home.statListings")} />
          <Stat value={stats.agencies} label={t("home.statAgencies")} />
          <Stat value={stats.merged} label={t("home.statDedup")} />
        </section>

        <section style={{ padding: "2.5rem 0" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "1rem" }}>
            {t("home.whyTitle")}
          </h2>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))",
            gap: "1rem",
          }}>
            {[
              ["why1Title", "why1Body", "var(--color-gold)"],
              ["why2Title", "why2Body", "var(--color-fresh)"],
              ["why3Title", "why3Body", "var(--color-brand)"],
            ].map(([title, body, color]) => (
              <div key={title} className="card" style={{ padding: "1.125rem 1.25rem" }}>
                <h3 style={{
                  fontSize: "0.9375rem", fontWeight: 700, marginBottom: "0.5rem", color,
                }}>
                  {t(`home.${title}`)}
                </h3>
                <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", lineHeight: 1.65 }}>
                  {t(`home.${body}`)}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section style={{ paddingBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "1rem" }}>
            {t("home.popularAreas")}
          </h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {areas.map((a) => (
              <Link key={a.slug} href={`/${locale}/search?area=${a.slug}`} className="chip"
                    style={{
                      border: "1px solid var(--color-line)", background: "var(--color-surface)",
                      padding: "0.4375rem 0.875rem", fontSize: "0.875rem", fontWeight: 600,
                      whiteSpace: "normal",
                    }}>
                {i18nField(a.name, locale)}
                <span style={{ color: "var(--color-ink-faint)", fontWeight: 500 }}>{a.n}</span>
              </Link>
            ))}
          </div>
        </section>

        <section style={{ paddingBottom: "2.5rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                        gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>{t("home.featured")}</h2>
            <Link href={`/${locale}/search`} style={{ fontSize: "0.875rem", color: "var(--color-brand)", fontWeight: 600 }}>
              {t("home.browseAll")} →
            </Link>
          </div>
          <PropertyGrid items={featured.slice(0, 8)} locale={locale} t={t} transaction="sale" />
        </section>

        <section style={{ paddingBottom: "3rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                        gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>
              {t("nav.foreignEligible")}
              <span style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500,
                             color: "var(--color-ink-soft)", marginTop: "0.25rem" }}>
                {t("filters.foreignEligibleHint")}
              </span>
            </h2>
            <Link href={`/${locale}/search?foreign=1`} style={{ fontSize: "0.875rem", color: "var(--color-brand)", fontWeight: 600 }}>
              {t("home.browseAll")} →
            </Link>
          </div>
          <PropertyGrid items={foreignOk.slice(0, 4)} locale={locale} t={t} transaction="sale" />
        </section>
      </div>
    </>
  );
}
