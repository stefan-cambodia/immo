import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslator, isLocale, LOCALES, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import { getDeveloper } from "@/lib/projects";
import { ProjectGrid } from "@/components/ProjectCard";

// Fiche promoteur (phase 3) : ses projets, livrés et à venir.
export const revalidate = 900;

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string; slug: string }> }
): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const data = await getDeveloper(slug);
  if (!data) return {};
  const t = await getTranslator(locale);
  return {
    title: t("projects.projectsBy", { name: data.developer.name }),
    description: `${t("projects.projectsBy", { name: data.developer.name })} — ${
      t("projects.developerProjects", { n: data.projects.length })}`,
    alternates: {
      canonical: `/${locale}/developer/${slug}`,
      languages: {
        ...Object.fromEntries(
          LOCALES.map((l) => [l === "zh" ? "zh-Hans" : l, `/${l}/developer/${slug}`])
        ),
        "x-default": `/en/developer/${slug}`,
      },
    },
  };
}

export default async function DeveloperPage({
  params,
}: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const data = await getDeveloper(slug);
  if (!data) notFound();
  const { developer, projects } = data;
  const listings = projects.reduce((a, p) => a + p.listings, 0);
  const units = projects.reduce((a, p) => a + (p.totalUnits ?? 0), 0);

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <nav aria-label="breadcrumb" style={{
        fontSize: "0.8125rem", color: "var(--color-ink-faint)", marginBottom: "0.75rem",
        display: "flex", gap: "0.375rem", flexWrap: "wrap",
      }}>
        <Link href={`/${locale}`}>{t("common.siteName")}</Link>
        <span aria-hidden>/</span>
        <Link href={`/${locale}/projects`}>{t("projects.title")}</Link>
        <span aria-hidden>/</span>
        <span style={{ color: "var(--color-ink-soft)" }}>{developer.name}</span>
      </nav>

      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("projects.projectsBy", { name: developer.name })}
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", marginTop: "0.375rem" }}>
          {t("projects.developerProjects", { n: projects.length })}
          {units > 0 && ` · ${t("projects.unitsTotal", { n: formatNumber(units, locale) })}`}
          {listings > 0 && ` · ${t("projects.activeListings", { n: listings })}`}
        </p>
      </header>

      <ProjectGrid items={projects} locale={locale} t={t} />
    </div>
  );
}
