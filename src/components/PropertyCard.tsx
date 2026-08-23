import Link from "next/link";
import { formatUsd, formatKhr, formatNumber } from "@/lib/format";
import { i18nField, type Locale, type Translator } from "@/lib/i18n";
import type { PropertyCard as Card } from "@/lib/search";
import { AgencyCountBadge, ForeignEligibleBadge, FreshnessBadge } from "./Badges";

export function PropertyCardItem({
  item, locale, t, transaction,
}: { item: Card; locale: Locale; t: Translator; transaction: "sale" | "rent" }) {
  const area = item.indoorArea ?? item.landArea;
  const min = Number(item.priceMin);
  const max = Number(item.priceMax);
  const spread = max > min;

  return (
    <article className="card" style={{ display: "flex", flexDirection: "column" }}>
      <Link href={`/${locale}/property/${item.reference}`} style={{ display: "block", position: "relative" }}>
        <div className="ph" style={{ aspectRatio: "4 / 3", position: "relative" }}>
          {item.photo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.photo}
              alt=""
              loading="lazy"
              decoding="async"
              width={400}
              height={300}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          )}
        </div>
        {item.featured && (
          <span className="chip" style={{
            position: "absolute", top: 10, left: 10,
            background: "var(--color-gold)", color: "#fff",
          }}>
            ★
          </span>
        )}
      </Link>

      <div style={{ padding: "0.875rem 1rem 1rem", display: "flex", flexDirection: "column", gap: "0.5rem", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <strong style={{ fontSize: "1.125rem", letterSpacing: "-0.01em" }}>
            {spread && <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: "var(--color-ink-faint)" }}>
              {t("common.from")}{" "}
            </span>}
            {formatUsd(min, locale, true)}
            {transaction === "rent" && (
              <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: "var(--color-ink-faint)" }}>
                {" "}{t("common.perMonth")}
              </span>
            )}
          </strong>
          <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
            {formatKhr(min, locale)}
          </span>
        </div>

        <Link href={`/${locale}/property/${item.reference}`} style={{ color: "inherit" }}>
          <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, lineHeight: 1.4 }}>
            {t(`propertyType.${item.propertyType}`)}
            {item.buildingName && ` · ${i18nField(item.buildingName, locale)}`}
          </h3>
        </Link>

        <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
          {i18nField(item.locationName, locale)}
          {item.parentName && `, ${i18nField(item.parentName, locale)}`}
        </p>

        <ul style={{
          display: "flex", gap: "0.75rem", flexWrap: "wrap",
          fontSize: "0.8125rem", color: "var(--color-ink-soft)",
        }}>
          {item.bedrooms > 0 && <li>{item.bedrooms} {t("common.bedrooms")}</li>}
          {item.bathrooms > 0 && <li>{item.bathrooms} {t("common.bathrooms")}</li>}
          {area && <li>{formatNumber(area, locale)} {t("common.sqm")}</li>}
          {item.floor !== null && item.floor > 0 && <li>{t("common.floor")} {item.floor}</li>}
        </ul>

        <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginTop: "auto", paddingTop: "0.25rem" }}>
          {item.foreignEligible && <ForeignEligibleBadge t={t} />}
          <AgencyCountBadge count={item.agencyCount} t={t} />
          <FreshnessBadge lastConfirmed={item.lastConfirmed} t={t} locale={locale} />
        </div>
      </div>
    </article>
  );
}

export function PropertyGrid({
  items, locale, t, transaction,
}: { items: Card[]; locale: Locale; t: Translator; transaction: "sale" | "rent" }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(clamp(240px, 30vw, 300px), 1fr))",
      gap: "1rem",
    }}>
      {items.map((item) => (
        <PropertyCardItem key={item.id} item={item} locale={locale} t={t} transaction={transaction} />
      ))}
    </div>
  );
}
