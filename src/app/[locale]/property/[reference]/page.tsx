import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslator, i18nField, isLocale, HTML_LANG, type Locale } from "@/lib/i18n";
import { daysSince, daysUntil, formatDate, formatKhr, formatNumber, formatUsd } from "@/lib/format";
import { getProperty, similarProperties } from "@/lib/search";
import { estimate, pricePosition } from "@/lib/estimate";
import { getMapProvider } from "@/lib/map-provider";
import { Gallery } from "@/components/Gallery";
import { PriceHistory } from "@/components/PriceHistory";
import { ContactAgent } from "@/components/ContactAgent";
import { MapPanel } from "@/components/MapPanel";
import { AgencyCountBadge, ForeignEligibleBadge, FreshnessBadge, TitleBadge,
         TitleVerifiedBadge } from "@/components/Badges";
import { PropertyGrid } from "@/components/PropertyCard";
import { ViewBeacon } from "@/components/ViewBeacon";
import { WebVitals } from "@/components/WebVitals";

export const revalidate = 120;

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string; reference: string }> }
): Promise<Metadata> {
  const { locale, reference } = await params;
  if (!isLocale(locale)) return {};
  const data = await getProperty(reference);
  if (!data) return {};
  const t = await getTranslator(locale);
  const { property, offers } = data;
  const where = i18nField(property.locationName, locale as Locale);
  const title = `${t(`propertyType.${property.propertyType}`)} · ${where} · ${property.reference}`;

  return {
    title,
    description: i18nField(offers[0]?.description, locale as Locale) || title,
    alternates: {
      canonical: `/${locale}/property/${reference}`,
      languages: {
        ...Object.fromEntries(
          (["fr", "en", "zh", "km"] as const).map((l) => [HTML_LANG[l], `/${l}/property/${reference}`])
        ),
        "x-default": `/en/property/${reference}`,
      },
    },
  };
}

export default async function PropertyPage({
  params,
}: { params: Promise<{ locale: string; reference: string }> }) {
  const { locale: raw, reference } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const data = await getProperty(reference);
  if (!data) notFound();
  const { property: p, offers, photos } = data;
  if (offers.length === 0) notFound();

  const transaction = offers[0].transactionType as "sale" | "rent";
  const prices = offers.map((o) => Number(o.price));
  const min = Math.min(...prices), max = Math.max(...prices);
  const agencyCount = new Set(offers.map((o) => o.agencyId)).size;
  const area = p.indoorArea ?? p.landArea;
  const similar = await similarProperties(p.id, 4);
  const provider = getMapProvider();
  // Position du prix par rapport à la médiane du secteur (phase 4) — muette
  // sous MIN_SAMPLE comparables plutôt que faussement précise.
  const position = await pricePosition(
    p.locationSlug, p.propertyType, transaction, min, Number(area) || 0);
  // Rendement locatif brut pour un bien à vendre : loyer estimé du secteur ×
  // 12 / prix demandé. Muet si les comparables de location manquent ou
  // doivent s'élargir au pays entier.
  const rentEstimate = transaction === "sale" && Number(area) > 0
    ? await estimate({
        locationSlug: p.locationSlug, propertyType: p.propertyType,
        transaction: "rent", areaSqm: Number(area),
      })
    : null;
  const grossYield = rentEstimate && rentEstimate.level !== "country" && min > 0
    ? (rentEstimate.value * 12 / min) * 100
    : null;

  // Pourquoi le bien est — ou n'est pas — accessible à un acheteur étranger (§5.3).
  const foreignReason = p.foreignEligible
    ? t("property.foreignEligibleYesWhy")
    : p.propertyType === "land"
      ? t("property.foreignEligibleNoLand")
      : (p.floor ?? 0) === 0
        ? t("property.foreignEligibleNoGround")
        : t("property.foreignEligibleNoTitle");

  const facts: [string, string][] = [
    ...(p.bedrooms > 0 ? [[t("common.bedrooms"), String(p.bedrooms)] as [string, string]] : []),
    ...(p.bathrooms > 0 ? [[t("common.bathrooms"), String(p.bathrooms)] as [string, string]] : []),
    ...(p.indoorArea ? [[t("property.indoorArea"), `${formatNumber(p.indoorArea, locale)} ${t("common.sqm")}`] as [string, string]] : []),
    ...(p.landArea ? [[t("property.landArea"), `${formatNumber(p.landArea, locale)} ${t("common.sqm")}`] as [string, string]] : []),
    ...(p.floor !== null ? [[t("common.floor"), p.floor === 0 ? t("common.groundFloor") : String(p.floor)] as [string, string]] : []),
    ...(p.unitNumber ? [[t("property.unitNumber"), p.unitNumber] as [string, string]] : []),
    ...(p.yearBuilt ? [[t("property.yearBuilt"), String(p.yearBuilt)] as [string, string]] : []),
    [t("filters.titleType"), t(`titleType.${p.titleType}`)],
    [t("filters.furnished"), p.furnished ? "✓" : "—"],
    ...(area ? [[t("property.pricePerSqm", { price: "" }).trim() || "USD/m²",
        formatUsd(min / Number(area), locale)] as [string, string]] : []),
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: `${t(`propertyType.${p.propertyType}`)} · ${i18nField(p.locationName, locale)}`,
    identifier: p.reference,
    datePosted: offers[0].lastConfirmed,
    url: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/${locale}/property/${p.reference}`,
    numberOfBedrooms: p.bedrooms || undefined,
    numberOfBathroomsTotal: p.bathrooms || undefined,
    floorSize: area ? { "@type": "QuantitativeValue", value: Number(area), unitCode: "MTK" } : undefined,
    geo: { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng },
    offers: offers.map((o) => ({
      "@type": "Offer",
      price: Number(o.price),
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      seller: { "@type": "RealEstateAgent", name: o.agencyName },
    })),
  };

  return (
    <>
      <script type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {/* Mesure d'audience : côté client, la fiche étant servie en ISR. */}
      <ViewBeacon propertyId={p.id} locale={locale} />
      {/* Budget de performance (§7) : la fiche porte la galerie, c'est elle
          qui décide du LCP mobile. */}
      <WebVitals locale={locale} route="property" />

      <div style={{ maxWidth: "72rem", margin: "0 auto", padding: "1rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
        <nav aria-label="breadcrumb" style={{
          fontSize: "0.8125rem", color: "var(--color-ink-faint)", marginBottom: "0.875rem",
          display: "flex", gap: "0.375rem", flexWrap: "wrap",
        }}>
          <Link href={`/${locale}`}>{t("common.siteName")}</Link>
          <span aria-hidden>/</span>
          {p.parentSlug && (
            <>
              <Link href={`/${locale}/search?area=${p.parentSlug}`}>{i18nField(p.parentName, locale)}</Link>
              <span aria-hidden>/</span>
            </>
          )}
          <Link href={`/${locale}/search?area=${p.locationSlug}`}>{i18nField(p.locationName, locale)}</Link>
          <span aria-hidden>/</span>
          <span>{p.reference}</span>
        </nav>

        <Gallery photos={photos} alt={`${t(`propertyType.${p.propertyType}`)} ${i18nField(p.locationName, locale)}`} />

        <div style={{
          display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "2rem",
          marginTop: "1.5rem",
        }}>
          <header>
            <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginBottom: "0.625rem" }}>
              {p.foreignEligible && <ForeignEligibleBadge t={t} />}
              <TitleBadge titleType={p.titleType} t={t} />
              {p.titleVerifiedAt && p.titleVerifiedBy && (
                <TitleVerifiedBadge t={t} hint={t("titles.verifiedNote", {
                  partner: p.titleVerifiedBy, date: formatDate(p.titleVerifiedAt, locale),
                })} />
              )}
              <AgencyCountBadge count={agencyCount} t={t} />
              <FreshnessBadge lastConfirmed={offers[0].lastConfirmed} t={t} locale={locale} withDate />
              <span className="chip" style={{ background: "var(--color-surface-alt)", color: "var(--color-ink-soft)" }}>
                {t("common.reference")} {p.reference}
              </span>
            </div>

            <h1 style={{ fontSize: "clamp(1.375rem, 3.5vw, 1.875rem)", fontWeight: 800,
                         letterSpacing: "-0.02em", lineHeight: 1.25 }}>
              {t(`propertyType.${p.propertyType}`)}
              {p.villaSub && ` · ${t(`villaSub.${p.villaSub}`)}`}
              {p.buildingName && ` · ${i18nField(p.buildingName, locale)}`}
            </h1>
            <p style={{ color: "var(--color-ink-soft)", marginTop: "0.25rem" }}>
              {i18nField(p.locationName, locale)}
              {p.parentName && `, ${i18nField(p.parentName, locale)}`}
            </p>

            {/* La phrase qui résume la proposition de valeur (§3.3). */}
            <div style={{
              marginTop: "1rem", padding: "1rem 1.125rem",
              background: "var(--color-gold-soft)", border: "1px solid var(--color-gold)",
              borderRadius: "0.75rem",
            }}>
              <strong style={{ fontSize: "1.0625rem", lineHeight: 1.4, display: "block" }}>
                {agencyCount > 1
                  ? t("property.offersSummary", {
                      count: agencyCount,
                      min: formatUsd(min, locale),
                      max: formatUsd(max, locale),
                    })
                  : `${t("property.offersSummaryOne")} — ${formatUsd(min, locale)}`}
                {transaction === "rent" && ` ${t("common.perMonth")}`}
              </strong>
              <span style={{ display: "block", fontSize: "0.8125rem", color: "var(--color-ink-soft)", marginTop: "0.375rem" }}>
                {formatKhr(min, locale)}
                {max > min && ` · ${t("property.priceSpreadNote", {
                  spread: formatUsd(max - min, locale),
                })}`}
              </span>
              {position && (
                <span style={{ display: "block", fontSize: "0.8125rem", marginTop: "0.375rem" }}>
                  <strong style={{
                    color: position.deltaPct > 5 ? "var(--color-danger)"
                      : position.deltaPct < -5 ? "var(--color-fresh)" : "var(--color-ink-soft)",
                  }}>
                    {position.deltaPct > 0
                      ? t("estimate.aboveMedian", { pct: position.deltaPct })
                      : position.deltaPct < 0
                        ? t("estimate.belowMedian", { pct: Math.abs(position.deltaPct) })
                        : t("estimate.atMedian")}
                  </strong>
                  <span style={{ color: "var(--color-ink-soft)" }}>
                    {" "}· {t("estimate.positionNote", {
                      n: position.n,
                      area: position.usedName ? i18nField(position.usedName, locale) : "",
                    })}
                  </span>
                  {" · "}
                  <Link href={`/${locale}/estimate?area=${p.locationSlug}&type=${p.propertyType}`
                    + `${transaction === "rent" ? "&txn=rent" : ""}&sqm=${Math.round(Number(area))}`}
                        style={{ color: "var(--color-brand)", fontWeight: 600 }}>
                    {t("estimate.title")} →
                  </Link>
                </span>
              )}
              {grossYield !== null && rentEstimate && (
                <span style={{ display: "block", fontSize: "0.8125rem", marginTop: "0.375rem" }}
                      title={t("estimate.yieldDisclaimer")}>
                  <strong>{t("estimate.yieldTitle")} : {grossYield.toFixed(1)} %</strong>
                  <span style={{ color: "var(--color-ink-soft)" }}>
                    {" "}· {t("estimate.yieldRent", { rent: formatUsd(rentEstimate.value, locale) })}
                    {" "}· {t("estimate.comparables", { n: rentEstimate.stats.n })}{" "}
                    {rentEstimate.usedName
                      ? t("estimate.scope", { area: i18nField(rentEstimate.usedName, locale) })
                      : ""}
                  </span>
                </span>
              )}
            </div>
          </header>

          {/* --------------------------------------------- Éligibilité étranger */}
          <section style={{
            padding: "1rem 1.125rem", borderRadius: "0.75rem",
            border: `1px solid ${p.foreignEligible ? "var(--color-brand)" : "var(--color-line)"}`,
            background: p.foreignEligible ? "var(--color-brand-soft)" : "var(--color-surface-alt)",
            display: "flex", gap: "0.875rem", alignItems: "start",
          }}>
            <span aria-hidden style={{
              fontSize: "1.25rem", lineHeight: 1,
              color: p.foreignEligible ? "var(--color-brand)" : "var(--color-ink-faint)",
            }}>
              {p.foreignEligible ? "✓" : "✕"}
            </span>
            <div>
              <strong style={{ display: "block", fontSize: "0.9375rem" }}>
                {t(p.foreignEligible ? "property.foreignEligibleYes" : "property.foreignEligibleNo")}
              </strong>
              <span style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
                {foreignReason} {t(`titleType.${p.titleType}Hint`)}
              </span>
              {/* Vérification documentaire du titre (phase 4) : partenaire
                  nommé et date, jamais un badge anonyme. */}
              {p.titleVerifiedAt && p.titleVerifiedBy && (
                <span style={{ display: "block", fontSize: "0.8125rem", marginTop: "0.5rem", lineHeight: 1.6 }}>
                  <strong style={{ color: "var(--color-fresh)" }}>
                    ✓ {t("titles.verifiedNote", {
                      partner: p.titleVerifiedBy,
                      date: formatDate(p.titleVerifiedAt, locale),
                    })}
                  </strong>{" "}
                  <span style={{ color: "var(--color-ink-faint)" }}>
                    {t("titles.verifiedDisclaimer")}
                  </span>
                </span>
              )}
            </div>
          </section>

          {/* ------------------------------------------------------- Caractéristiques */}
          <section>
            <h2 style={{ fontSize: "1.0625rem", fontWeight: 700, marginBottom: "0.75rem" }}>
              {t("property.characteristics")}
            </h2>
            <dl style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 10rem), 1fr))",
              gap: "0.75rem 1.25rem",
            }}>
              {facts.map(([label, value]) => (
                <div key={label} style={{ borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.5rem" }}>
                  <dt style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", lineHeight: 1.4 }}>{label}</dt>
                  <dd style={{ fontWeight: 600, fontSize: "0.9375rem", lineHeight: 1.4 }}>{value}</dd>
                </div>
              ))}
            </dl>

            {p.amenities.length > 0 && (
              <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginTop: "1rem" }}>
                {p.amenities.map((a: string) => (
                  <span key={a} className="chip" style={{
                    background: "var(--color-surface-alt)", color: "var(--color-ink-soft)",
                    whiteSpace: "normal",
                  }}>
                    {t(`amenity.${a}`)}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------- Les offres */}
          <section>
            <h2 style={{ fontSize: "1.0625rem", fontWeight: 700, marginBottom: "0.75rem" }}>
              {t("property.offersTitle")}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {offers.map((o) => {
                const stale = daysSince(o.lastConfirmed) > 30;
                const expiring = daysUntil(o.expiresAt);
                return (
                  <article key={o.id} className="card" style={{ padding: "1rem 1.125rem" }}>
                    <div style={{
                      display: "flex", justifyContent: "space-between", gap: "1rem",
                      flexWrap: "wrap", alignItems: "start",
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                          <Link href={`/${locale}/agency/${o.agencySlug}`} style={{ fontWeight: 700 }}>
                            {o.agencyName}
                          </Link>
                          {o.agencyVerification === "verified" && (
                            <span className="chip" style={{
                              background: "var(--color-fresh-soft)", color: "var(--color-fresh)",
                            }}>
                              ✓ {t("agency.verified")}
                            </span>
                          )}
                          {o.featured && (
                            <span className="chip" style={{ background: "var(--color-gold)", color: "#fff" }}>★</span>
                          )}
                        </div>
                        <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", marginTop: "0.25rem" }}>
                          {o.agentName} · {t("property.speaks")}{" "}
                          {(o.spokenLangs as string[]).join(", ").toUpperCase()}
                        </p>
                      </div>

                      <div style={{ textAlign: "end" }}>
                        <div style={{ fontSize: "1.25rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
                          {formatUsd(o.price, locale)}
                          {o.pricePeriod === "monthly" && (
                            <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: "var(--color-ink-faint)" }}>
                              {" "}{t("common.perMonth")}
                            </span>
                          )}
                        </div>
                        {o.negotiable && (
                          <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                            {t("property.negotiable")}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{
                      display: "flex", gap: "0.5rem", flexWrap: "wrap",
                      alignItems: "center", marginTop: "0.75rem",
                    }}>
                      <FreshnessBadge lastConfirmed={o.lastConfirmed} t={t} locale={locale} withDate />
                      {stale && (
                        <span className="chip" style={{
                          background: "var(--color-stale-soft)", color: "var(--color-stale)", whiteSpace: "normal",
                        }}>
                          {t("property.staleWarning")}
                        </span>
                      )}
                      {expiring <= 7 && expiring > 0 && (
                        <span className="chip" style={{
                          background: "var(--color-danger-soft)", color: "var(--color-danger)",
                        }}>
                          {t("property.expiresIn", { n: expiring })}
                        </span>
                      )}
                      {/* Annonce collectée sur un portail public (§6.1) : la
                          source est citée et reste accessible d'un clic. Les
                          faits viennent d'elle ; le texte et les photos non. */}
                      {o.sourceUrl && (
                        <a href={o.sourceUrl} target="_blank" rel="noopener nofollow"
                           title={t("property.sourceListingHint")}
                           className="chip" style={{
                             border: "1px solid var(--color-line)", color: "var(--color-ink-soft)",
                           }}>
                          {t("property.sourceListing")} ↗
                        </a>
                      )}
                    </div>

                    {o.description && (
                      <p lang={HTML_LANG[locale]} style={{
                        fontSize: "0.875rem", color: "var(--color-ink-soft)",
                        lineHeight: 1.65, marginTop: "0.75rem",
                      }}>
                        {i18nField(o.description, locale)}
                        {/* Traduction machine marquée visuellement (§4.1). */}
                        {o.machineTranslated && o.sourceLang !== locale && (
                          <span style={{
                            display: "inline-block", marginInlineStart: "0.5rem", fontSize: "0.6875rem",
                            color: "var(--color-ink-faint)", border: "1px solid var(--color-line)",
                            borderRadius: "999px", padding: "0.0625rem 0.5rem", verticalAlign: "middle",
                          }}>
                            {t("property.machineTranslated", { lang: o.sourceLang.toUpperCase() })}
                          </span>
                        )}
                      </p>
                    )}

                    {o.history && o.history.length > 1 && (
                      <div style={{ marginTop: "0.875rem" }}>
                        <PriceHistory history={o.history} locale={locale} t={t} />
                      </div>
                    )}

                    <div style={{ marginTop: "0.875rem" }}>
                      <ContactAgent
                        listingId={o.id}
                        locale={locale}
                        phone={o.phone}
                        telegram={o.telegram}
                        wechat={o.wechat}
                        sourceUrl={o.sourceUrl}
                        labels={{
                          reveal: t("property.revealPhone"),
                          call: t("property.callAgent"),
                          telegram: t("property.telegram"),
                          wechat: t("property.wechat"),
                          source: t("property.seeSourceListing"),
                        }}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {/* ------------------------------------------------------- Emplacement */}
          <section>
            <h2 style={{ fontSize: "1.0625rem", fontWeight: 700, marginBottom: "0.75rem" }}>
              {t("property.location")}
            </h2>
            <div style={{
              height: "clamp(260px, 42vh, 420px)", borderRadius: "0.75rem",
              overflow: "hidden", border: "1px solid var(--color-line)", position: "relative",
            }}>
              <MapPanel
                locale={locale}
                style={provider.style}
                attribution={provider.attribution}
                maxZoom={provider.maxZoom}
                center={[p.lng, p.lat]}
                zoom={16}
                // La fiche situe un bien déjà choisi : pas de dessin de zone
                // ni de « chercher dans cette zone » ici.
                mode="locate"
                labels={{
                  searchThisArea: t("map.searchThisArea"),
                  drawPolygon: t("map.draw"),
                  clearPolygon: t("map.clearDraw"),
                  finishPolygon: t("map.finishDraw"),
                  autoSearch: t("map.autoSearch"),
                  loading: t("common.loading"),
                  bedrooms: t("common.bedrooms"),
                  agencyCount: t("property.agencyCountShort", { n: "{n}" }),
                  unavailable: t("map.unavailable"),
                  unavailableHint: t("map.unavailableHint"),
                  loadFailed: t("map.loadFailed"),
                }}
              />
            </div>
            <p style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", marginTop: "0.5rem", lineHeight: 1.6 }}>
              {/* La provenance du pin est inscrite dans `geo_pin_by` : une
                  annonce collectée n'a pas été pointée par une agence chez
                  nous, et la légende ne doit pas le laisser croire. */}
              {t(p.geoPinBy?.startsWith("portal:") ? "property.pinNoteSource" : "property.pinNote")}
              {p.geoPinAt && ` — ${formatDate(p.geoPinAt, locale)}`}
            </p>

            {p.buildingName && (
              <div className="card" style={{ padding: "1rem 1.125rem", marginTop: "1rem" }}>
                <strong style={{ display: "block", marginBottom: "0.375rem" }}>
                  {t("property.inBuilding")} · {i18nField(p.buildingName, locale)}
                </strong>
                <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
                  {[
                    p.buildingFloors && t("property.buildingFloors", { n: p.buildingFloors }),
                    p.buildingUnits && t("property.buildingUnits", { n: p.buildingUnits }),
                    p.buildingStatus === "under_construction"
                      ? t("property.underConstruction")
                      : p.buildingYear && t("property.completedIn", { year: p.buildingYear }),
                    p.developerName,
                  ].filter(Boolean).join(" · ")}
                </p>
                <span style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                  <Link href={`/${locale}/project/${p.buildingSlug}`}
                        style={{ fontSize: "0.875rem", color: "var(--color-brand)", fontWeight: 600 }}>
                    {t("projects.viewProject")} →
                  </Link>
                  <Link href={`/${locale}/search?building=${p.buildingSlug}`}
                        style={{ fontSize: "0.875rem", color: "var(--color-brand)", fontWeight: 600 }}>
                    {t("agency.viewListings")} →
                  </Link>
                </span>
              </div>
            )}
          </section>

          {similar.length > 0 && (
            <section>
              <div style={{ display: "flex", gap: "0.75rem", alignItems: "baseline",
                            justifyContent: "space-between", flexWrap: "wrap", marginBottom: "0.75rem" }}>
                <h2 style={{ fontSize: "1.0625rem", fontWeight: 700 }}>
                  {t("property.similar")}
                </h2>
                <Link href={`/${locale}/compare?refs=${[p.reference,
                        ...similar.slice(0, 3).map((s) => s.reference)].join(",")}`}
                      style={{ fontSize: "0.875rem", color: "var(--color-brand)", fontWeight: 600 }}>
                  {t("compare.similarLink")} →
                </Link>
              </div>
              <PropertyGrid items={similar} locale={locale} t={t} transaction={transaction} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
