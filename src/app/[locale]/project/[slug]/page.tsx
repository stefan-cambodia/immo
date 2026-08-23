import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslator, i18nField, isLocale, LOCALES, type Locale } from "@/lib/i18n";
import { formatNumber, formatUsd } from "@/lib/format";
import { getProject, projectProperties } from "@/lib/projects";
import { PropertyGrid } from "@/components/PropertyCard";
import { ProjectStatusChip } from "@/components/ProjectCard";

// Fiche projet / immeuble / borey (phase 3). La page a un contenu propre
// (étages, unités, statut, promoteur) même sans annonce active : elle reste
// indexable — un acheteur sur plan cherche précisément les projets sans
// annonce en revente.
export const revalidate = 900;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string; slug: string }> }
): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const p = await getProject(slug);
  if (!p) return {};
  const t = await getTranslator(locale);
  const name = i18nField(p.name, locale);
  const where = i18nField(p.locationName, locale);
  return {
    title: `${name} · ${where}`,
    description: [
      t(`projects.status_${p.status}`),
      p.totalFloors && t("property.buildingFloors", { n: p.totalFloors }),
      p.totalUnits && t("property.buildingUnits", { n: p.totalUnits }),
      p.developerName && t("projects.byDeveloper", { name: p.developerName }),
      p.listings > 0 && t("projects.activeListings", { n: p.listings }),
    ].filter(Boolean).join(" · "),
    alternates: {
      canonical: `/${locale}/project/${slug}`,
      languages: {
        ...Object.fromEntries(
          LOCALES.map((l) => [l === "zh" ? "zh-Hans" : l, `/${l}/project/${slug}`])
        ),
        "x-default": `/en/project/${slug}`,
      },
    },
  };
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div style={{ borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.5rem" }}>
    <div style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)" }}>{label}</div>
    <div style={{ fontWeight: 700, fontSize: "0.9375rem" }}>{value}</div>
  </div>
);

export default async function ProjectPage({
  params,
}: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const p = await getProject(slug);
  if (!p) notFound();
  const rows = p.listings > 0 ? await projectProperties(p.id) : [];
  const name = i18nField(p.name, locale);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ApartmentComplex",
    name,
    url: `${SITE}/${locale}/project/${p.slug}`,
    numberOfAccommodationUnits: p.totalUnits ?? undefined,
    yearBuilt: p.status === "completed" ? p.completionYear ?? undefined : undefined,
    containedInPlace: { "@type": "Place", name: i18nField(p.locationName, locale) },
    geo: { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng },
  };

  const range = (min: string | null, max: string | null) =>
    min ? `${formatUsd(min, locale, true)}${max && max !== min ? ` – ${formatUsd(max, locale, true)}` : ""}` : null;
  const sale = range(p.saleMin, p.saleMax);
  const rent = range(p.rentMin, p.rentMax);

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <script type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <nav aria-label="breadcrumb" style={{
        fontSize: "0.8125rem", color: "var(--color-ink-faint)", marginBottom: "0.75rem",
        display: "flex", gap: "0.375rem", flexWrap: "wrap",
      }}>
        <Link href={`/${locale}`}>{t("common.siteName")}</Link>
        <span aria-hidden>/</span>
        <Link href={`/${locale}/projects`}>{t("projects.title")}</Link>
        <span aria-hidden>/</span>
        <span style={{ color: "var(--color-ink-soft)" }}>{name}</span>
      </nav>

      <header style={{ marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", gap: "0.625rem", alignItems: "center", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "clamp(1.375rem, 3.5vw, 2rem)", fontWeight: 800,
                       letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            {name}
          </h1>
          <ProjectStatusChip status={p.status} t={t} />
        </div>
        <p style={{ fontSize: "0.9375rem", color: "var(--color-ink-soft)", marginTop: "0.375rem" }}>
          <Link href={`/${locale}/search?area=${p.locationSlug}`} style={{ fontWeight: 600 }}>
            {i18nField(p.locationName, locale)}
          </Link>
          {p.parentName ? ` — ${i18nField(p.parentName, locale)}` : ""}
          {p.developerName && p.developerSlug && (
            <>
              {" · "}
              <Link href={`/${locale}/developer/${p.developerSlug}`} style={{ fontWeight: 600 }}>
                {t("projects.byDeveloper", { name: p.developerName })}
              </Link>
            </>
          )}
        </p>
      </header>

      <section style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
        gap: "0.75rem 1.25rem", marginBottom: "1.5rem", maxWidth: "56rem",
      }}>
        {p.totalFloors && (
          <Stat label={t("projects.floorsShort")} value={formatNumber(p.totalFloors, locale)} />
        )}
        {p.totalUnits && (
          <Stat label={t("projects.unitsShort")} value={formatNumber(p.totalUnits, locale)} />
        )}
        {p.completionYear && (
          <Stat label={t("projects.deliveryShort")} value={String(p.completionYear)} />
        )}
        {sale && <Stat label={t("common.forSale")} value={sale} />}
        {rent && <Stat label={t("common.forRent")} value={`${rent} ${t("common.perMonth")}`} />}
        {p.agencies > 0 && (
          <Stat label={t("projects.agenciesShort")} value={String(p.agencies)} />
        )}
      </section>

      {p.amenities.length > 0 && (
        <section style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginBottom: "1.75rem" }}>
          {p.amenities.map((a) => (
            <span key={a} className="chip" style={{
              background: "var(--color-surface-alt)", color: "var(--color-ink-soft)",
            }}>
              {t(`amenity.${a}`)}
            </span>
          ))}
        </section>
      )}

      {rows.length > 0 ? (
        <section>
          <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "0.75rem" }}>
            {t("projects.inProject")} ({formatNumber(p.properties, locale)})
          </h2>
          <PropertyGrid items={rows} locale={locale} t={t} transaction="sale" />
        </section>
      ) : (
        <section className="card" style={{ padding: "1.125rem 1.25rem", maxWidth: "40rem" }}>
          <p style={{ fontSize: "0.9375rem", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
            {t("projects.noListings")}
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <Link href={`/${locale}/search?area=${p.locationSlug}`} className="btn btn-outline">
              {t("projects.browseArea")} →
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}
