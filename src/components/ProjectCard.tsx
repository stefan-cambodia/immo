import Link from "next/link";
import { formatUsd } from "@/lib/format";
import { i18nField, type Locale, type Translator } from "@/lib/i18n";
import type { ProjectSummary } from "@/lib/projects";

const STATUS_STYLE: Record<string, { background: string; color: string }> = {
  planned: { background: "var(--color-surface-alt)", color: "var(--color-ink-soft)" },
  under_construction: { background: "var(--color-gold-soft)", color: "var(--color-gold)" },
  completed: { background: "var(--color-fresh-soft)", color: "var(--color-fresh)" },
};

export function ProjectStatusChip({ status, t }: { status: string; t: Translator }) {
  return (
    <span className="chip" style={STATUS_STYLE[status] ?? STATUS_STYLE.planned}>
      {t(`projects.status_${status}`)}
    </span>
  );
}

export function ProjectCard({ p, locale, t }: {
  p: ProjectSummary; locale: Locale; t: Translator;
}) {
  const specs = [
    p.totalFloors && t("property.buildingFloors", { n: p.totalFloors }),
    p.totalUnits && t("property.buildingUnits", { n: p.totalUnits }),
    p.completionYear && (p.status === "completed"
      ? t("property.completedIn", { year: p.completionYear })
      : t("projects.delivery", { year: p.completionYear })),
  ].filter(Boolean).join(" · ");

  return (
    <Link href={`/${locale}/project/${p.slug}`} className="card" style={{
      display: "flex", flexDirection: "column", gap: "0.5rem",
      padding: "1rem 1.125rem", color: "inherit",
    }}>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "space-between",
                    alignItems: "start", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: "1rem", lineHeight: 1.3 }}>
          {i18nField(p.name, locale)}
        </span>
        <ProjectStatusChip status={p.status} t={t} />
      </div>

      <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)" }}>
        {i18nField(p.locationName, locale)}
        {p.parentName ? ` — ${i18nField(p.parentName, locale)}` : ""}
      </span>

      {specs && (
        <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)" }}>{specs}</span>
      )}

      {p.developerName && (
        <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
          {t("projects.byDeveloper", { name: p.developerName })}
        </span>
      )}

      <span style={{ fontSize: "0.8125rem", fontWeight: 600, marginTop: "auto",
                     color: p.listings > 0 ? "var(--color-brand)" : "var(--color-ink-faint)" }}>
        {p.listings > 0
          ? `${t("projects.activeListings", { n: p.listings })}${
              p.priceMin ? ` · ${formatUsd(p.priceMin, locale, true)}${
                p.priceMax && p.priceMax !== p.priceMin
                  ? ` – ${formatUsd(p.priceMax, locale, true)}` : ""}` : ""}`
          : t(`projects.status_${p.status}`)}
      </span>
    </Link>
  );
}

export function ProjectGrid({ items, locale, t }: {
  items: ProjectSummary[]; locale: Locale; t: Translator;
}) {
  return (
    <div style={{
      display: "grid", gap: "1rem",
      gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 17rem), 1fr))",
    }}>
      {items.map((p) => <ProjectCard key={p.slug} p={p} locale={locale} t={t} />)}
    </div>
  );
}
