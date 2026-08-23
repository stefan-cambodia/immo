import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslator, i18nField, isLocale, type Locale, type Translator } from "@/lib/i18n";
import { daysSince, formatDate, formatNumber, formatUsd } from "@/lib/format";
import { getProperty } from "@/lib/search";
import { estimate, pricePosition, type PricePosition } from "@/lib/estimate";

/**
 * Comparateur de biens (phase 4).
 *
 * La sélection vit dans l'URL (`?refs=A,B,C`) : la comparaison se partage, se
 * met en favori et fonctionne sans JavaScript (principe n°4). Les colonnes ne
 * se contentent pas d'aligner les caractéristiques : chaque bien est situé
 * dans son marché — position sur la médiane du secteur, rendement brut — via
 * la même bibliothèque que l'estimateur, donc les mêmes définitions.
 */
export const revalidate = 300;

const MAX_COLS = 4;

type SP = Record<string, string | string[] | undefined>;

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  // Combinatoire infinie de paramètres : consultable, jamais indexée.
  return { title: t("compare.title"), robots: { index: false, follow: true } };
}

interface Column {
  reference: string;
  photo: string | null;
  propertyType: string;
  villaSub: string | null;
  locationSlug: string;
  locationName: Record<string, string>;
  parentName: Record<string, string> | null;
  buildingSlug: string | null;
  buildingName: Record<string, string> | null;
  transaction: "sale" | "rent";
  priceMin: number;
  priceMax: number;
  agencies: number;
  area: number | null;
  indoorArea: string | null;
  landArea: string | null;
  bedrooms: number;
  bathrooms: number;
  floor: number | null;
  titleType: string;
  foreignEligible: boolean;
  furnished: boolean | null;
  amenities: string[];
  lastConfirmed: string;
  position: PricePosition | null;
  grossYield: number | null;
  estimatedRent: number | null;
}

async function buildColumn(reference: string): Promise<Column | null> {
  const data = await getProperty(reference);
  if (!data || data.offers.length === 0) return null;
  const { property: p, offers, photos } = data;

  const prices = offers.map((o) => Number(o.price));
  const priceMin = Math.min(...prices);
  const transaction = offers[0].transactionType as "sale" | "rent";
  const area = Number(p.indoorArea ?? p.landArea) || null;

  const position = area
    ? await pricePosition(p.locationSlug, p.propertyType, transaction, priceMin, area)
    : null;
  const rentEstimate = transaction === "sale" && area
    ? await estimate({
        locationSlug: p.locationSlug, propertyType: p.propertyType,
        transaction: "rent", areaSqm: area,
      })
    : null;
  const usableRent = rentEstimate && rentEstimate.level !== "country" ? rentEstimate : null;

  return {
    reference: p.reference,
    photo: photos[0]?.url ?? null,
    propertyType: p.propertyType,
    villaSub: p.villaSub,
    locationSlug: p.locationSlug,
    locationName: p.locationName,
    parentName: p.parentName,
    buildingSlug: p.buildingSlug,
    buildingName: p.buildingName,
    transaction,
    priceMin,
    priceMax: Math.max(...prices),
    agencies: new Set(offers.map((o) => o.agencyId)).size,
    area,
    indoorArea: p.indoorArea,
    landArea: p.landArea,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    floor: p.floor,
    titleType: p.titleType,
    foreignEligible: p.foreignEligible,
    furnished: p.furnished,
    amenities: p.amenities,
    lastConfirmed: offers[0].lastConfirmed,
    position,
    grossYield: usableRent && priceMin > 0 ? (usableRent.value * 12 / priceMin) * 100 : null,
    estimatedRent: usableRent?.value ?? null,
  };
}

const th = {
  textAlign: "start" as const, verticalAlign: "top" as const,
  padding: "0.5rem 0.75rem 0.5rem 0", fontSize: "0.75rem", fontWeight: 600,
  color: "var(--color-ink-faint)", whiteSpace: "nowrap" as const,
};
const td = {
  verticalAlign: "top" as const, padding: "0.5rem 0.875rem 0.5rem 0",
  fontSize: "0.875rem", minWidth: "11rem",
};

function Row({ label, cols, render }: {
  label: string;
  cols: Column[];
  render: (c: Column) => React.ReactNode;
}) {
  return (
    <tr style={{ borderTop: "1px solid var(--color-line-soft)" }}>
      <th scope="row" style={th}>{label}</th>
      {cols.map((c) => <td key={c.reference} style={td}>{render(c)}</td>)}
    </tr>
  );
}

const check = (on: boolean) => (on ? "✓" : "—");

function removeHref(locale: string, refs: string[], ref: string) {
  const rest = refs.filter((r) => r !== ref);
  return rest.length > 0
    ? `/${locale}/compare?refs=${rest.join(",")}`
    : `/${locale}/compare`;
}

export default async function ComparePage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<SP> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t: Translator = await getTranslator(locale);

  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  };

  // `refs` porte la sélection ; `add` vient du formulaire d'ajout — les deux
  // fusionnent ici, sans état côté client.
  const requested = [...one("refs").split(","), one("add")]
    .map((r) => r.trim().toUpperCase())
    .filter((r) => /^[A-Z]{2}-[A-Z0-9]+$/.test(r))
    .filter((r, i, all) => all.indexOf(r) === i);
  const overflow = requested.length > MAX_COLS;
  const refs = requested.slice(0, MAX_COLS);

  const columns = (await Promise.all(refs.map(buildColumn))).filter(Boolean) as Column[];
  const found = new Set(columns.map((c) => c.reference));
  const unknown = refs.filter((r) => !found.has(r));
  const kept = columns.map((c) => c.reference);

  const amenityUnion = [...new Set(columns.flatMap((c) => c.amenities))];

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <header style={{ marginBottom: "1.25rem", maxWidth: "48rem" }}>
        <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("compare.title")}
        </h1>
        <p style={{ color: "var(--color-ink-soft)", fontSize: "0.9375rem", lineHeight: 1.6, marginTop: "0.375rem" }}>
          {t("compare.subtitle")}
        </p>
      </header>

      <form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap",
                                  alignItems: "center", marginBottom: "1.25rem" }}>
        {kept.length > 0 && <input type="hidden" name="refs" value={kept.join(",")} />}
        <label style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", fontWeight: 600 }}>
          {t("compare.addByRef")}
        </label>
        <input className="field" type="text" name="add" placeholder={t("compare.refPlaceholder")}
               style={{ width: "11rem" }} />
        <button type="submit" className="btn btn-outline">{t("compare.add")}</button>
      </form>

      {unknown.length > 0 && (
        <p role="alert" style={{
          marginBottom: "1rem", padding: "0.625rem 0.875rem", borderRadius: "0.5rem",
          background: "var(--color-danger-soft)", color: "var(--color-danger)",
          fontSize: "0.875rem", fontWeight: 600,
        }}>
          {unknown.map((r) => t("compare.unknownRef", { ref: r })).join(" · ")}
        </p>
      )}
      {overflow && (
        <p style={{ marginBottom: "1rem", fontSize: "0.8125rem", color: "var(--color-ink-faint)" }}>
          {t("compare.limitNote")}
        </p>
      )}

      {columns.length === 0 ? (
        <p className="card" style={{ padding: "1.125rem 1.25rem", color: "var(--color-ink-soft)",
                                     fontSize: "0.9375rem", maxWidth: "40rem" }}>
          {t("compare.emptyHint")}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <td style={th} />
                {columns.map((c) => (
                  <td key={c.reference} style={td}>
                    {c.photo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.photo} alt={`${t(`propertyType.${c.propertyType}`)} ${c.reference}`}
                           style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover",
                                    borderRadius: "0.5rem", marginBottom: "0.5rem" }} />
                    )}
                    <Link href={`/${locale}/property/${c.reference}`}
                          style={{ fontWeight: 700, display: "block" }}>
                      {t(`propertyType.${c.propertyType}`)}
                      {c.villaSub && ` · ${t(`villaSub.${c.villaSub}`)}`}
                    </Link>
                    <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", display: "block" }}>
                      {i18nField(c.locationName, locale)}
                      {c.parentName && `, ${i18nField(c.parentName, locale)}`}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", display: "block" }}>
                      {c.reference} · {t(c.transaction === "rent" ? "common.forRent" : "common.forSale")}
                    </span>
                    <Link href={removeHref(locale, kept, c.reference)}
                          style={{ fontSize: "0.75rem", color: "var(--color-danger)", fontWeight: 600 }}>
                      ✕ {t("compare.remove")}
                    </Link>
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label={t("compare.rowPrice")} cols={columns} render={(c) => (
                <strong>
                  {formatUsd(c.priceMin, locale)}
                  {c.priceMax > c.priceMin && ` – ${formatUsd(c.priceMax, locale)}`}
                  {c.transaction === "rent" && ` ${t("common.perMonth")}`}
                </strong>
              )} />
              <Row label={t("compare.rowPerSqm")} cols={columns} render={(c) =>
                c.area ? formatUsd(Math.round(c.priceMin / c.area), locale) : "—"} />
              <Row label={t("compare.rowPosition")} cols={columns} render={(c) =>
                c.position ? (
                  <span style={{
                    fontWeight: 600,
                    color: c.position.deltaPct > 5 ? "var(--color-danger)"
                      : c.position.deltaPct < -5 ? "var(--color-fresh)" : "var(--color-ink-soft)",
                  }}>
                    {c.position.deltaPct > 0
                      ? t("estimate.aboveMedian", { pct: c.position.deltaPct })
                      : c.position.deltaPct < 0
                        ? t("estimate.belowMedian", { pct: Math.abs(c.position.deltaPct) })
                        : t("estimate.atMedian")}
                  </span>
                ) : "—"} />
              <Row label={t("estimate.yieldTitle")} cols={columns} render={(c) =>
                c.grossYield !== null ? (
                  <span title={t("estimate.yieldDisclaimer")}>
                    <strong>{c.grossYield.toFixed(1)} %</strong>
                    {c.estimatedRent !== null && (
                      <span style={{ display: "block", fontSize: "0.75rem", color: "var(--color-ink-soft)" }}>
                        {t("estimate.yieldRent", { rent: formatUsd(c.estimatedRent, locale) })}
                      </span>
                    )}
                  </span>
                ) : "—"} />
              <Row label={t("property.indoorArea")} cols={columns} render={(c) =>
                c.indoorArea ? `${formatNumber(c.indoorArea, locale)} ${t("common.sqm")}` : "—"} />
              <Row label={t("property.landArea")} cols={columns} render={(c) =>
                c.landArea ? `${formatNumber(c.landArea, locale)} ${t("common.sqm")}` : "—"} />
              <Row label={t("common.bedrooms")} cols={columns} render={(c) =>
                c.bedrooms > 0 ? String(c.bedrooms) : "—"} />
              <Row label={t("common.bathrooms")} cols={columns} render={(c) =>
                c.bathrooms > 0 ? String(c.bathrooms) : "—"} />
              <Row label={t("common.floor")} cols={columns} render={(c) =>
                c.floor === null ? "—" : c.floor === 0 ? t("common.groundFloor") : String(c.floor)} />
              <Row label={t("filters.titleType")} cols={columns} render={(c) =>
                t(`titleType.${c.titleType}`)} />
              <Row label={t("nav.foreignEligible")} cols={columns} render={(c) =>
                <span style={{ color: c.foreignEligible ? "var(--color-fresh)" : "var(--color-ink-faint)",
                               fontWeight: 700 }}>{check(c.foreignEligible)}</span>} />
              <Row label={t("filters.furnished")} cols={columns} render={(c) => check(Boolean(c.furnished))} />
              <Row label={t("property.lastConfirmed")} cols={columns} render={(c) => (
                <span style={{ color: daysSince(c.lastConfirmed) > 30
                    ? "var(--color-stale)" : "var(--color-ink)" }}>
                  {formatDate(c.lastConfirmed, locale)}
                </span>
              )} />
              <Row label={t("compare.rowAgencies")} cols={columns} render={(c) => String(c.agencies)} />
              <Row label={t("property.inBuilding")} cols={columns} render={(c) =>
                c.buildingName && c.buildingSlug ? (
                  <Link href={`/${locale}/project/${c.buildingSlug}`}>
                    {i18nField(c.buildingName, locale)}
                  </Link>
                ) : "—"} />
              {amenityUnion.map((a) => (
                <Row key={a} label={t(`amenity.${a}`)} cols={columns}
                     render={(c) => check(c.amenities.includes(a))} />
              ))}
              <Row label="" cols={columns} render={(c) => (
                <Link href={`/${locale}/property/${c.reference}`} className="btn btn-outline"
                      style={{ padding: "0.3125rem 0.75rem", fontSize: "0.8125rem" }}>
                  {t("compare.viewProperty")} →
                </Link>
              )} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
