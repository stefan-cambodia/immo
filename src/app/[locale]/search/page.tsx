import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { queryOne } from "@/lib/db";
import { getTranslator, i18nField, isLocale, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import {
  PAGE_SIZE, SORTS, filtersToQueryString, logSearchMiss, parseFilters,
  searchProperties, suggest, type Filters,
} from "@/lib/search";
import { getMapProvider, PHNOM_PENH } from "@/lib/map-provider";
import { FilterPanel } from "@/components/FilterPanel";
import { PropertyGrid } from "@/components/PropertyCard";
import { MapPanel } from "@/components/MapPanel";
import { SearchBeacon } from "@/components/SearchBeacon";
import { WebVitals } from "@/components/WebVitals";

type SP = Record<string, string | string[] | undefined>;

export async function generateMetadata(
  { params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SP> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  const f = parseFilters(await searchParams);
  const area = f.locationSlug
    ? await queryOne<{ name: Record<string, string> }>(
        `SELECT name_i18n AS name FROM locations WHERE slug = $1`, [f.locationSlug])
    : null;

  const scope = area ? i18nField(area.name, locale as Locale) : "Cambodia";
  return {
    title: `${t(f.transaction === "rent" ? "common.forRent" : "common.forSale")} — ${scope}`,
    description: t("home.heroSubtitle"),
    // Une page de résultats filtrée n'a pas vocation à être indexée ;
    // les pages SEO par quartier × type × langue arrivent en phase 3.
    robots: f.q || f.bbox || f.polygon ? { index: false, follow: true } : undefined,
  };
}

export default async function SearchPage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<SP> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const sp = await searchParams;
  const f: Filters = parseFilters(sp);
  const view = (Array.isArray(sp.view) ? sp.view[0] : sp.view) === "map" ? "map" : "list";

  // Saisie libre : la table d'alias fait la résolution. Si rien ne s'en
  // approche, la recherche est journalisée — c'est elle qui alimentera les
  // alias manquants (§5.2, §10).
  let resolvedLabel: string | null = null;
  let unresolved = false;
  if (f.q && !f.locationSlug && !f.buildingSlug) {
    const [best] = await suggest(f.q, 1);
    if (best && best.score >= 0.45) {
      if (best.kind === "location") f.locationSlug = best.slug;
      else f.buildingSlug = best.slug;
      resolvedLabel = i18nField(best.name, locale);
    } else {
      unresolved = true;
      await logSearchMiss(f.q, locale, { transaction: f.transaction, types: f.types });
    }
  }

  const { rows, total } = unresolved
    ? { rows: [], total: 0 }
    : await searchProperties(f);

  const area = f.locationSlug
    ? await queryOne<{ name: Record<string, string>; parent: Record<string, string> | null }>(
        `SELECT l.name_i18n AS name, p.name_i18n AS parent
         FROM locations l LEFT JOIN locations p ON p.id = l.parent_id WHERE l.slug = $1`,
        [f.locationSlug])
    : null;

  const building = f.buildingSlug
    ? await queryOne<{ name: Record<string, string> }>(
        `SELECT name_i18n AS name FROM buildings WHERE slug = $1`, [f.buildingSlug])
    : null;

  const pages = Math.ceil(total / PAGE_SIZE);
  const link = (patch: Partial<Filters> & { view?: string }) => {
    const qs = filtersToQueryString({ ...f, ...patch });
    const extra = patch.view ? `${qs ? "&" : "?"}view=${patch.view}` : view === "map" ? `${qs ? "&" : "?"}view=map` : "";
    return `/${locale}/search${qs}${extra}`;
  };

  const provider = getMapProvider();
  const mapCenter: [number, number] = rows.length
    ? [rows[0].lng, rows[0].lat]
    : PHNOM_PENH.center;

  const heading = building
    ? i18nField(building.name, locale)
    : area
      ? i18nField(area.name, locale)
      : t(f.transaction === "rent" ? "common.forRent" : "common.forSale");

  return (
    <div className={`search-shell${view === "map" ? " search-shell--map" : ""}`}>
      {/* Mesures : la recherche en texte libre alimente le dénominateur du
          taux d'échec (§10), le LCP la cible de performance (§7). Les deux
          sont mesurées côté navigateur — voir les composants. */}
      {f.q && <SearchBeacon q={f.q} locale={locale} resolved={!unresolved} />}
      <WebVitals locale={locale} route="search" />
      {/* Bascule liste / carte. Elle vit ICI, au niveau de la coquille, et non
          dans l'en-tête des résultats : en vue carte la colonne des résultats
          est masquée, et une bascule qui disparaît en même temps qu'elle
          enferme le visiteur dans la carte. Au-delà de 1180 px les deux
          panneaux cohabitent et la bascule n'a plus d'objet (CSS). */}
      <div className="view-toggle seg" role="group" aria-label={t("common.map")}>
        <Link href={link({ view: "list" })} className="seg-btn" aria-pressed={view !== "map"}>
          {t("common.list")} · {formatNumber(total, locale)}
        </Link>
        <Link href={link({ view: "map" })} className="seg-btn" aria-pressed={view === "map"}>
          {t("common.map")}
        </Link>
      </div>

      <aside className="search-filters">
        {/* `open` est porteur : au-delà de 900 px le résumé est masqué et le
            panneau doit rester déplié. Les navigateurs récents cachent le
            contenu d'un `<details>` fermé par `::details-content`, hors de
            portée d'un `display: block` sur l'enfant — la colonne de filtres
            serait vide sur ordinateur. Sur mobile en vue carte, c'est l'ordre
            d'affichage qui règle le problème : la carte passe AVANT les
            filtres (voir `.search-shell--map` dans globals.css). */}
        <details open>
          <summary className="btn btn-outline" style={{ width: "100%", marginBottom: "0.75rem" }}>
            {t("filters.title")}
          </summary>
          <div>
            <FilterPanel f={f} locale={locale} t={t} />
          </div>
        </details>
      </aside>

      <div className="search-main" style={{ display: view === "map" ? "none" : undefined }}>
        <header style={{ display: "flex", gap: "0.75rem", alignItems: "baseline",
                         justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
              {heading}
            </h1>
            <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", marginTop: "0.125rem" }}>
              {formatNumber(total, locale)} {t(total === 1 ? "common.result" : "common.results")}
              {area?.parent && ` · ${i18nField(area.parent, locale)}`}
              {resolvedLabel && f.q && ` · « ${f.q} » → ${resolvedLabel}`}
              {f.polygon && ` · ${t("common.map")}`}
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            {/* Alerte sur ces critères (phase 3). Le lien porte les filtres
                résolus — le quartier, pas le texte tapé. Il est absent quand
                la saisie n'a rien donné : une alerte sur rien n'a pas de sens. */}
            {!unresolved && (
              <Link href={`/${locale}/alerts${filtersToQueryString({ ...f, page: 1, sort: "relevance" })}`}
                    className="btn btn-outline"
                    style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem",
                             color: "var(--color-brand)", borderColor: "var(--color-brand)" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M8 2a4 4 0 0 0-4 4v3l-1.5 2h11L12 9V6a4 4 0 0 0-4-4ZM6.5 13a1.5 1.5 0 0 0 3 0"
                        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
                {t("alerts.createButton")}
              </Link>
            )}
            <nav aria-label={t("filters.sort")} style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
              {SORTS.map((s) => (
                <Link key={s} href={link({ sort: s, page: 1 })} className="chip"
                      style={{
                        padding: "0.3125rem 0.625rem",
                        border: `1px solid ${f.sort === s ? "var(--color-brand)" : "var(--color-line)"}`,
                        color: f.sort === s ? "var(--color-brand)" : "var(--color-ink-soft)",
                        background: f.sort === s ? "var(--color-brand-soft)" : "var(--color-surface)",
                      }}>
                  {t(`filters.sort${s === "relevance" ? "Relevance"
                      : s === "price_asc" ? "PriceAsc"
                      : s === "price_desc" ? "PriceDesc"
                      : s === "freshest" ? "Freshest" : "AreaDesc"}`)}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        {rows.length === 0 ? (
          <div className="card" style={{ padding: "2rem 1.5rem", textAlign: "center" }}>
            <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>{t("common.noResults")}</p>
            <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", maxWidth: "32rem",
                        marginInline: "auto", lineHeight: 1.6 }}>
              {t("common.noResultsHint")}
            </p>
          </div>
        ) : (
          <PropertyGrid items={rows} locale={locale} t={t} transaction={f.transaction} />
        )}

        {pages > 1 && (
          <nav aria-label={t("common.page")} style={{
            display: "flex", gap: "0.5rem", alignItems: "center",
            justifyContent: "center", paddingTop: "0.5rem", flexWrap: "wrap",
          }}>
            {f.page > 1 && (
              <Link href={link({ page: f.page - 1 })} className="btn btn-outline"
                    style={{ padding: "0.375rem 0.75rem", fontSize: "0.875rem" }}>
                ← {t("common.previous")}
              </Link>
            )}
            <span style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>
              {t("common.page")} {f.page} / {pages}
            </span>
            {f.page < pages && (
              <Link href={link({ page: f.page + 1 })} className="btn btn-outline"
                    style={{ padding: "0.375rem 0.75rem", fontSize: "0.875rem" }}>
                {t("common.next")} →
              </Link>
            )}
          </nav>
        )}
      </div>

      <div className="search-map" style={{ display: view === "list" ? "none" : undefined }}>
        <MapPanel
          locale={locale}
          style={provider.style}
          attribution={provider.attribution}
          maxZoom={provider.maxZoom}
          center={mapCenter}
          zoom={rows.length ? 13 : PHNOM_PENH.zoom}
          labels={{
            searchThisArea: t("map.searchThisArea"),
            drawPolygon: t("map.draw"),
            clearPolygon: t("map.clearDraw"),
            finishPolygon: t("map.finishDraw"),
            autoSearch: t("map.autoSearch"),
            loading: t("common.loading"),
            bedrooms: t("common.bedrooms"),
            // Le gabarit part tel quel : la bulle y substitue le nombre.
            agencyCount: t("property.agencyCountShort", { n: "{n}" }),
            unavailable: t("map.unavailable"),
            unavailableHint: t("map.unavailableHint"),
          }}
        />
      </div>
    </div>
  );
}
