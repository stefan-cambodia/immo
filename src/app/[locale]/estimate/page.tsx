import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { query } from "@/lib/db";
import { getTranslator, i18nField, isLocale, LOCALES, type Locale } from "@/lib/i18n";
import { formatNumber, formatUsd } from "@/lib/format";
import { estimate, priceTrend, MIN_SAMPLE, type TrendPoint } from "@/lib/estimate";
import { PROPERTY_TYPES } from "@/lib/search";

// Estimation de prix par quartier (phase 4). Formulaire GET pur : le résultat
// a une URL, se partage, et fonctionne sans JavaScript (principe n°4).
export const revalidate = 900;

type SP = Record<string, string | string[] | undefined>;

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return {
    title: t("estimate.title"),
    description: t("estimate.subtitle"),
    alternates: {
      // Les variantes avec paramètres ne sont pas des pages distinctes.
      canonical: `/${locale}/estimate`,
      languages: {
        ...Object.fromEntries(
          LOCALES.map((l) => [l === "zh" ? "zh-Hans" : l, `/${l}/estimate`])
        ),
        "x-default": "/en/estimate",
      },
    },
  };
}

/** Courbe de tendance en SVG pur, rendue serveur — pas de bibliothèque (§7). */
function TrendLine({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;
  const w = 640, h = 90, pad = 6;
  const values = points.map((p) => p.perSqm);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (w - pad * 2) + pad;
      const y = h - pad - ((p.perSqm - min) / span) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}
         preserveAspectRatio="none" role="img" aria-hidden>
      <path d={`${path} L${w - pad},${h - pad} L${pad},${h - pad} Z`}
            fill="var(--color-brand)" opacity="0.10" />
      <path d={path} fill="none" stroke="var(--color-brand)" strokeWidth="1.5"
            vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default async function EstimatePage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<SP> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const areas = await query<{
    slug: string; name: Record<string, string>; parent: Record<string, string> | null;
  }>(
    `SELECT l.slug, l.name_i18n AS name, p.name_i18n AS parent
     FROM locations l LEFT JOIN locations p ON p.id = l.parent_id
     WHERE l.level IN ('neighborhood', 'district') AND l.listing_count > 0
     ORDER BY l.listing_count DESC`
  );

  const areaSlug = one("area");
  const type = (PROPERTY_TYPES as readonly string[]).includes(one("type")) ? one("type") : "condo";
  const transaction = one("txn") === "rent" ? "rent" as const : "sale" as const;
  const sqm = Number(one("sqm"));
  const wantsEstimate = areaSlug !== "" && Number.isFinite(sqm) && sqm > 0;

  const result = wantsEstimate
    ? await estimate({ locationSlug: areaSlug, propertyType: type, transaction, areaSqm: sqm })
    : null;
  const trend = result
    ? await priceTrend(result.usedSlug, type, transaction)
    : [];
  const trendDelta = trend.length >= 2
    ? Math.round(((trend[trend.length - 1].perSqm - trend[0].perSqm) / trend[0].perSqm) * 100)
    : null;

  const requestedName = result ? i18nField(result.requestedName, locale) : "";
  const usedName = result
    ? (result.usedName ? i18nField(result.usedName, locale) : t("estimate.scopeCountry"))
    : "";

  const searchHref = `/${locale}/search?${new URLSearchParams({
    ...(result?.usedSlug ? { area: result.usedSlug } : {}),
    type,
    ...(transaction === "rent" ? { txn: "rent" } : {}),
  }).toString()}`;

  return (
    <div style={{ maxWidth: "60rem", margin: "0 auto", padding: "2rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <header style={{ marginBottom: "1.5rem", maxWidth: "44rem" }}>
        <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("estimate.title")}
        </h1>
        <p style={{ color: "var(--color-ink-soft)", fontSize: "0.9375rem", lineHeight: 1.6, marginTop: "0.375rem" }}>
          {t("estimate.subtitle")}
        </p>
      </header>

      <form method="get" className="card" style={{
        padding: "1.125rem 1.25rem", display: "grid", gap: "0.75rem",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
        alignItems: "end", marginBottom: "1.5rem",
      }}>
        <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
          {t("estimate.formArea")}
          <select className="field" name="area" required defaultValue={areaSlug}
                  style={{ marginTop: "0.25rem" }}>
            <option value="" disabled>—</option>
            {areas.map((a) => (
              <option key={a.slug} value={a.slug}>
                {i18nField(a.name, locale)}
                {a.parent ? ` — ${i18nField(a.parent, locale)}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
          {t("estimate.formType")}
          <select className="field" name="type" defaultValue={type} style={{ marginTop: "0.25rem" }}>
            {PROPERTY_TYPES.map((x) => (
              <option key={x} value={x}>{t(`propertyType.${x}`)}</option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
          {t("filters.transaction")}
          <select className="field" name="txn" defaultValue={transaction} style={{ marginTop: "0.25rem" }}>
            <option value="sale">{t("common.forSale")}</option>
            <option value="rent">{t("common.forRent")}</option>
          </select>
        </label>

        <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
          {t("estimate.formSqm")}
          <input className="field" type="number" name="sqm" inputMode="numeric"
                 min={10} max={10000} required defaultValue={sqm > 0 ? sqm : ""}
                 style={{ marginTop: "0.25rem" }} />
        </label>

        <button type="submit" className="btn btn-primary" style={{ justifyContent: "center" }}>
          {t("estimate.submit")}
        </button>
      </form>

      {wantsEstimate && !result && (
        <p role="status" className="card" style={{
          padding: "1.125rem 1.25rem", color: "var(--color-ink-soft)", fontSize: "0.9375rem",
        }}>
          {t("estimate.noData")}
        </p>
      )}

      {result && (
        <section className="card" style={{ padding: "1.5rem 1.5rem 1.25rem" }}>
          <div style={{ display: "flex", gap: "0.625rem", alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
              {t(transaction === "rent" ? "estimate.resultRent" : "estimate.resultSale")}
            </span>
            <span className="chip" style={{
              background: result.confidence === "high" ? "var(--color-fresh-soft)"
                : result.confidence === "medium" ? "var(--color-gold-soft)" : "var(--color-surface-alt)",
              color: result.confidence === "high" ? "var(--color-fresh)"
                : result.confidence === "medium" ? "var(--color-gold)" : "var(--color-ink-soft)",
            }}>
              {t(`estimate.confidence_${result.confidence}`)}
            </span>
          </div>

          <p style={{ fontSize: "clamp(1.75rem, 5vw, 2.5rem)", fontWeight: 800,
                      letterSpacing: "-0.02em", lineHeight: 1.2, marginTop: "0.25rem" }}>
            <data value={result.value} data-estimate>
              {formatUsd(result.value, locale)}
            </data>
            {transaction === "rent" && (
              <span style={{ fontSize: "1rem", fontWeight: 600, color: "var(--color-ink-soft)" }}>
                {" "}{t("common.perMonth")}
              </span>
            )}
          </p>

          <p style={{ fontSize: "0.9375rem", color: "var(--color-ink-soft)", marginTop: "0.375rem" }}>
            {t("estimate.range")} : {formatUsd(result.low, locale)} – {formatUsd(result.high, locale)}
            {" · "}
            {t("estimate.perSqm", { price: formatUsd(Math.round(result.stats.perSqmMedian), locale) })}
          </p>

          <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", marginTop: "0.75rem" }}>
            {t("estimate.comparables", { n: formatNumber(result.stats.n, locale) })}{" "}
            {result.usedName
              ? t("estimate.scope", { area: usedName })
              : t("estimate.scopeCountry")}
          </p>

          {result.level !== "exact" && (
            <p role="note" style={{
              marginTop: "0.625rem", padding: "0.625rem 0.75rem", borderRadius: "0.5rem",
              background: "var(--color-stale-soft)", color: "var(--color-stale)",
              fontSize: "0.8125rem", fontWeight: 600, lineHeight: 1.5,
            }}>
              {result.level === "country"
                ? t("estimate.fallbackCountry", { requested: requestedName })
                : t("estimate.fallback", { requested: requestedName, used: usedName })}
            </p>
          )}

          {trend.length >= 2 ? (
            <div style={{ marginTop: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem",
                            alignItems: "baseline", flexWrap: "wrap", marginBottom: "0.375rem" }}>
                <h2 style={{ fontSize: "0.875rem", fontWeight: 700 }}>{t("estimate.trendTitle")}</h2>
                {trendDelta !== null && (
                  <span style={{
                    fontSize: "0.8125rem", fontWeight: 700,
                    color: trendDelta > 0 ? "var(--color-fresh)"
                      : trendDelta < 0 ? "var(--color-danger)" : "var(--color-ink-soft)",
                  }}>
                    {trendDelta > 0 ? t("estimate.trendUp", { pct: trendDelta })
                      : trendDelta < 0 ? t("estimate.trendDown", { pct: Math.abs(trendDelta) })
                      : t("estimate.trendFlat")}
                  </span>
                )}
              </div>
              <TrendLine points={trend} />
              <div style={{ display: "flex", justifyContent: "space-between",
                            fontSize: "0.6875rem", color: "var(--color-ink-faint)" }}>
                <span>{trend[0].month}</span>
                <span>{trend[trend.length - 1].month}</span>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-faint)", marginTop: "1rem" }}>
              {t("estimate.trendThin")}
            </p>
          )}

          <p style={{ marginTop: "1.25rem" }}>
            <Link href={searchHref} className="btn btn-outline">
              {t("estimate.seeComparables")} →
            </Link>
          </p>
        </section>
      )}

      <section style={{ marginTop: "1.5rem", maxWidth: "44rem" }}>
        <h2 style={{ fontSize: "0.875rem", fontWeight: 700, marginBottom: "0.375rem" }}>
          {t("estimate.method")}
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", lineHeight: 1.65 }}>
          {t("estimate.methodText", { min: MIN_SAMPLE })}
        </p>
      </section>
    </div>
  );
}
