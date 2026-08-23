import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslator, isLocale, LOCALES, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import { listDevelopers, listProjects } from "@/lib/projects";
import { ProjectGrid } from "@/components/ProjectCard";

// Hub des projets neufs (phase 3). Peu de pages, riches et distinctes :
// indexables sans seuil, contrairement aux atterrissages quartier × type.
export const revalidate = 900;

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return {
    title: t("projects.title"),
    description: t("projects.subtitle"),
    alternates: {
      canonical: `/${locale}/projects`,
      languages: {
        ...Object.fromEntries(
          LOCALES.map((l) => [l === "zh" ? "zh-Hans" : l, `/${l}/projects`])
        ),
        "x-default": "/en/projects",
      },
    },
  };
}

export default async function ProjectsPage({
  params,
}: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const [projects, developers] = await Promise.all([listProjects(), listDevelopers()]);
  const upcoming = projects.filter((p) => p.status !== "completed");
  const completed = projects.filter((p) => p.status === "completed");

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <header style={{ marginBottom: "1.75rem", maxWidth: "48rem" }}>
        <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("projects.title")}
        </h1>
        <p style={{ color: "var(--color-ink-soft)", fontSize: "0.9375rem", lineHeight: 1.6, marginTop: "0.375rem" }}>
          {t("projects.subtitle")}
        </p>
      </header>

      {upcoming.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "0.75rem" }}>
            {t("projects.newProjects")}
          </h2>
          <ProjectGrid items={upcoming} locale={locale} t={t} />
        </section>
      )}

      <section style={{ marginBottom: "2.5rem" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          {t("projects.completedProjects")}
        </h2>
        <ProjectGrid items={completed} locale={locale} t={t} />
      </section>

      <section>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          {t("projects.developers")}
        </h2>
        <div style={{
          display: "grid", gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
        }}>
          {developers.map((d) => (
            <Link key={d.slug} href={`/${locale}/developer/${d.slug}`} className="card" style={{
              padding: "0.875rem 1rem", color: "inherit",
              display: "flex", flexDirection: "column", gap: "0.25rem",
            }}>
              <span style={{ fontWeight: 700 }}>{d.name}</span>
              <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)" }}>
                {t("projects.developerProjects", { n: d.projects })}
                {d.totalUnits > 0 && ` · ${t("projects.unitsTotal", { n: formatNumber(d.totalUnits, locale) })}`}
              </span>
              {d.listings > 0 && (
                <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-brand)" }}>
                  {t("projects.activeListings", { n: d.listings })}
                </span>
              )}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
