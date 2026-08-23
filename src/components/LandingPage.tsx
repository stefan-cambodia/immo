import Link from "next/link";
import { notFound } from "next/navigation";
import { formatNumber, formatUsd } from "@/lib/format";
import { getTranslator, i18nField, isLocale, type Locale } from "@/lib/i18n";
import { parseFilters, searchProperties } from "@/lib/search";
import {
  INDEX_THRESHOLD, isPropertyType, landingAlternates, landingPath, landingStats,
  siblingAreas, siblingTypes, txnFromSegment, type LandingScope,
} from "@/lib/seo";
import { PropertyGrid } from "./PropertyCard";

export interface LandingParams { locale: string; txn: string; area: string; type?: string }

export function parseScope(params: LandingParams): { locale: Locale; scope: LandingScope } | null {
  if (!isLocale(params.locale)) return null;
  const transaction = txnFromSegment(params.txn);
  if (!transaction) return null;
  if (params.type && !isPropertyType(params.type)) return null;
  return {
    locale: params.locale as Locale,
    scope: {
      transaction,
      segment: params.txn as "buy" | "rent",
      areaSlug: params.area,
      typeSlug: params.type ?? null,
    },
  };
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div style={{ borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.5rem" }}>
    <div style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)" }}>{label}</div>
    <div style={{ fontWeight: 700, fontSize: "0.9375rem" }}>{value}</div>
  </div>
);

function headingKey(scope: LandingScope) {
  if (scope.typeSlug) return scope.transaction === "rent" ? "landing.forRentIn" : "landing.forSaleIn";
  return scope.transaction === "rent" ? "landing.allForRentIn" : "landing.allForSaleIn";
}

export async function buildMetadata(params: LandingParams) {
  const parsed = parseScope(params);
  if (!parsed) return {};
  const { locale, scope } = parsed;
  const stats = await landingStats(scope);
  if (!stats) return {};

  const t = await getTranslator(locale);
  const area = i18nField(stats.areaName, locale);
  const type = scope.typeSlug ? t(`propertyType.${scope.typeSlug}`) : "";
  const title = t(headingKey(scope), { type, area }).trim();
  const median = stats.priceMedian ? formatUsd(stats.priceMedian, locale, true) : "—";

  return {
    title,
    description: t("landing.metaDescription", {
      count: stats.properties, area, median,
      txn: t(scope.transaction === "rent" ? "common.forRent" : "common.forSale").toLowerCase(),
    }),
    alternates: { canonical: landingPath(locale, scope), ...landingAlternates(scope) },
    // Sous le seuil d'inventaire, la page reste consultable mais sort de
    // l'index : mieux vaut pas de page qu'une page mince (§ lib/seo.ts).
    robots: stats.properties >= INDEX_THRESHOLD
      ? undefined
      : { index: false, follow: true },
  };
}

export async function LandingPage({ params }: { params: LandingParams }) {
  const parsed = parseScope(params);
  if (!parsed) notFound();
  const { locale, scope } = parsed;

  const stats = await landingStats(scope);
  if (!stats) notFound();

  const t = await getTranslator(locale);
  const area = i18nField(stats.areaName, locale);
  const type = scope.typeSlug ? t(`propertyType.${scope.typeSlug}`) : "";
  const heading = t(headingKey(scope), { type, area }).trim();
  const thin = stats.properties < INDEX_THRESHOLD;

  const { rows } = await searchProperties(parseFilters({
    area: scope.areaSlug,
    txn: scope.transaction === "rent" ? "rent" : "sale",
    ...(scope.typeSlug ? { type: scope.typeSlug } : {}),
    sort: "relevance",
  }));

  const [types, areas] = await Promise.all([siblingTypes(scope), siblingAreas(scope)]);

  const perMonth = scope.transaction === "rent" ? ` ${t("common.perMonth")}` : "";
  const searchHref = `/${locale}/search?area=${scope.areaSlug}`
    + (scope.transaction === "rent" ? "&txn=rent" : "")
    + (scope.typeSlug ? `&type=${scope.typeSlug}` : "");

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: t("common.siteName"), item: `/${locale}` },
          ...(stats.parentSlug ? [{
            "@type": "ListItem", position: 2,
            name: i18nField(stats.parentName, locale),
            item: landingPath(locale, { ...scope, areaSlug: stats.parentSlug, typeSlug: null }),
          }] : []),
          { "@type": "ListItem", position: stats.parentSlug ? 3 : 2, name: heading },
        ],
      },
      {
        "@type": "ItemList",
        numberOfItems: stats.properties,
        itemListElement: rows.slice(0, 12).map((r, i) => ({
          "@type": "ListItem", position: i + 1,
          url: `/${locale}/property/${r.reference}`,
        })),
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
        <nav aria-label="breadcrumb" style={{
          fontSize: "0.8125rem", color: "var(--color-ink-faint)", marginBottom: "0.75rem",
          display: "flex", gap: "0.375rem", flexWrap: "wrap",
        }}>
          <Link href={`/${locale}`}>{t("common.siteName")}</Link>
          {stats.parentSlug && (
            <>
              <span aria-hidden>/</span>
              <Link href={landingPath(locale, { ...scope, areaSlug: stats.parentSlug, typeSlug: null })}>
                {i18nField(stats.parentName, locale)}
              </Link>
            </>
          )}
          {scope.typeSlug && (
            <>
              <span aria-hidden>/</span>
              <Link href={landingPath(locale, { ...scope, typeSlug: null })}>{area}</Link>
            </>
          )}
        </nav>

        <header style={{ marginBottom: "1.25rem" }}>
          <h1 style={{ fontSize: "clamp(1.375rem, 3.5vw, 2rem)", fontWeight: 800,
                       letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            {heading}
          </h1>

          {stats.properties > 0 ? (
            <div style={{ marginTop: "0.625rem", maxWidth: "48rem", color: "var(--color-ink-soft)",
                          fontSize: "0.9375rem", lineHeight: 1.7 }}>
              {/* Texte écrit depuis les chiffres réels de la combinaison : deux
                  quartiers ne produisent pas la même page. */}
              <p>
                {t("landing.intro", {
                  count: formatNumber(stats.properties, locale),
                  agencies: stats.agencies,
                  median: stats.priceMedian ? formatUsd(stats.priceMedian, locale, true) : "—",
                  perMonth,
                })}
                {stats.pricePerSqm && ` ${t("landing.perSqm", {
                  price: formatUsd(stats.pricePerSqm, locale),
                })}`}
              </p>
              <p>
                {stats.areaMedian && stats.bedroomsMode
                  ? t("landing.typical", {
                      area: formatNumber(stats.areaMedian, locale), beds: stats.bedroomsMode })
                  : ""}
                {stats.foreignEligible > 0 && ` ${t("landing.foreignShare", { n: stats.foreignEligible })}`}
                {stats.freshWithin30 > 0 && ` ${t("landing.freshness", { n: stats.freshWithin30 })}`}
              </p>
            </div>
          ) : (
            <p style={{ marginTop: "0.5rem", color: "var(--color-ink-soft)" }}>
              {t("landing.emptyTitle")}
            </p>
          )}

          {thin && (
            <p style={{
              marginTop: "0.75rem", fontSize: "0.75rem", color: "var(--color-ink-faint)",
              borderInlineStart: "3px solid var(--color-line)", paddingInlineStart: "0.625rem",
            }}>
              {t("landing.thin")}
            </p>
          )}
        </header>

        {stats.properties > 0 && (
          <section style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
            gap: "0.75rem 1.25rem", marginBottom: "1.75rem",
          }}>
            <Stat label={t("home.statProperties")} value={formatNumber(stats.properties, locale)} />
            <Stat label={t("home.statAgencies")} value={String(stats.agencies)} />
            {stats.priceMin && (
              <Stat label={t("filters.priceRange")}
                    value={`${formatUsd(stats.priceMin, locale, true)} – ${formatUsd(stats.priceMax!, locale, true)}`} />
            )}
            {stats.pricePerSqm && (
              <Stat label={t("property.pricePerSqm", { price: "" }).trim() || "USD/m²"}
                    value={formatUsd(stats.pricePerSqm, locale)} />
            )}
            {stats.foreignEligible > 0 && (
              <Stat label={t("nav.foreignEligible")} value={String(stats.foreignEligible)} />
            )}
          </section>
        )}

        {rows.length > 0 && (
          <>
            <PropertyGrid items={rows.slice(0, 12)} locale={locale} t={t}
                          transaction={scope.transaction} />
            {stats.properties > 12 && (
              <p style={{ marginTop: "1.25rem" }}>
                <Link href={searchHref} className="btn btn-outline">
                  {t("landing.seeAll", { n: formatNumber(stats.properties, locale) })} →
                </Link>
              </p>
            )}
          </>
        )}

        {/* Maillage interne : chaque page renvoie vers ses voisines, ce qui
            fait circuler l'exploration au lieu de créer des culs-de-sac. */}
        {types.length > 0 && (
          <section style={{ marginTop: "2.5rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.625rem" }}>
              {t("landing.otherTypes")}
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {types.map((s) => (
                <Link key={s.type} className="chip"
                      href={landingPath(locale, { ...scope, typeSlug: s.type })}
                      style={{ border: "1px solid var(--color-line)", background: "var(--color-surface)",
                               padding: "0.4375rem 0.875rem", fontSize: "0.875rem", whiteSpace: "normal" }}>
                  {t(`propertyType.${s.type}`)}
                  <span style={{ color: "var(--color-ink-faint)", fontWeight: 500 }}>{s.n}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {areas.length > 0 && (
          <section style={{ marginTop: "1.75rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.625rem" }}>
              {t("landing.nearbyAreas")}
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {areas.map((s) => (
                <Link key={s.slug} className="chip"
                      href={landingPath(locale, { ...scope, areaSlug: s.slug })}
                      style={{ border: "1px solid var(--color-line)", background: "var(--color-surface)",
                               padding: "0.4375rem 0.875rem", fontSize: "0.875rem", whiteSpace: "normal" }}>
                  {i18nField(s.name, locale)}
                  <span style={{ color: "var(--color-ink-faint)", fontWeight: 500 }}>{s.n}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {scope.typeSlug && (
          <p style={{ marginTop: "1.75rem" }}>
            <Link href={landingPath(locale, { ...scope, typeSlug: null })}
                  style={{ color: "var(--color-brand)", fontWeight: 600, fontSize: "0.875rem" }}>
              ← {t("landing.backToArea", { area })}
            </Link>
          </p>
        )}
      </div>
    </>
  );
}
