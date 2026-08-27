import Link from "next/link";
import type { Locale, Translator } from "@/lib/i18n";
import { AMENITIES, PROPERTY_TYPES, TITLE_TYPES, type Filters } from "@/lib/search";

const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <fieldset style={{ borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.875rem" }}>
    <legend style={{
      fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase",
      letterSpacing: "0.04em", color: "var(--color-ink-faint)", marginBottom: "0.5rem",
    }}>
      {label}
    </legend>
    {children}
  </fieldset>
);

// Formulaire GET pur : les filtres fonctionnent sans JavaScript. Sur Android
// d'entrée de gamme et réseau contraint (principe n°4), c'est ce qui garantit
// que la page de résultats reste utilisable.
export function FilterPanel({
  f, locale, t,
}: { f: Filters; locale: Locale; t: Translator }) {
  return (
    <form
      action={`/${locale}/search`}
      method="get"
      style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}
    >
      {/* Contexte de recherche conservé d'un passage de filtre à l'autre. */}
      {f.q && <input type="hidden" name="q" value={f.q} />}
      {f.locationSlug && <input type="hidden" name="area" value={f.locationSlug} />}
      {f.buildingSlug && <input type="hidden" name="building" value={f.buildingSlug} />}
      {f.bbox && <input type="hidden" name="bbox" value={f.bbox.join(",")} />}
      {f.polygon && (
        <input type="hidden" name="polygon" value={f.polygon.map((c) => c.join(",")).join(";")} />
      )}
      {f.sort !== "relevance" && <input type="hidden" name="sort" value={f.sort} />}

      {/* Soumission implicite : la touche Entrée dans un champ active le premier
          bouton d'envoi du formulaire. Sans ce bouton-ci, ce serait « acheter »,
          et Entrée ferait basculer le marché à l'insu de l'utilisateur. */}
      <button type="submit" name="txn" value={f.transaction} tabIndex={-1} aria-hidden="true"
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />

      {/* Acheter / louer n'est pas un filtre parmi d'autres : c'est le marché
          regardé. Un clic l'applique immédiatement, sans passer par
          « Appliquer » — d'où deux boutons d'envoi plutôt que deux radios, qui
          se seraient contentés de cocher un contrôle invisible. */}
      <div role="group" aria-label={t("filters.transaction")} className="seg">
        {(["sale", "rent"] as const).map((txn) => (
          <button key={txn} type="submit" name="txn" value={txn} className="seg-btn"
                  aria-pressed={f.transaction === txn}>
            {t(txn === "sale" ? "common.forSale" : "common.forRent")}
          </button>
        ))}
      </div>

      {/* Le filtre le plus important pour l'audience expatriée : en tête, pas
          caché dans les filtres avancés (§5.3). */}
      <label className="filter-card">
        <input type="checkbox" name="foreign" value="1" defaultChecked={f.foreignEligible}
               style={{ marginTop: "0.1875rem" }} />
        <span>
          <span style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>
            {t("filters.foreignEligible")}
          </span>
          <span style={{ display: "block", fontSize: "0.75rem", color: "var(--color-ink-soft)" }}>
            {t("filters.foreignEligibleHint")}
          </span>
        </span>
      </label>

      <Section label={t("filters.priceRange")}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <input className="field" type="number" inputMode="numeric" name="pmin" min={0}
                 placeholder={t("filters.min")} defaultValue={f.priceMin ?? ""} aria-label={t("filters.min")} />
          <input className="field" type="number" inputMode="numeric" name="pmax" min={0}
                 placeholder={t("filters.max")} defaultValue={f.priceMax ?? ""} aria-label={t("filters.max")} />
        </div>
      </Section>

      <Section label={t("filters.propertyType")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          {PROPERTY_TYPES.map((type) => {
            const on = f.types.includes(type);
            return (
              <label key={type} className="chip chip-toggle">
                <input type="checkbox" name="type" value={type} defaultChecked={on}
                       style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} />
                {t(`propertyType.${type}`)}
              </label>
            );
          })}
        </div>
      </Section>

      <Section label={t("common.bedrooms")}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <select className="field" name="beds" defaultValue={f.bedsMin ?? ""} aria-label={t("filters.bedroomsMin")}>
            <option value="">{t("filters.bedroomsMin")}</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}+</option>)}
          </select>
          <select className="field" name="baths" defaultValue={f.bathsMin ?? ""} aria-label={t("filters.bathroomsMin")}>
            <option value="">{t("filters.bathroomsMin")}</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}+</option>)}
          </select>
        </div>
      </Section>

      <Section label={`${t("filters.areaMin")} · ${t("filters.floorMin")}`}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <input className="field" type="number" inputMode="numeric" name="area_min" min={0}
                 placeholder={t("filters.areaMin")} defaultValue={f.areaMin ?? ""} aria-label={t("filters.areaMin")} />
          <input className="field" type="number" inputMode="numeric" name="floor" min={0}
                 placeholder={t("filters.floorMin")} defaultValue={f.floorMin ?? ""} aria-label={t("filters.floorMin")} />
        </div>
      </Section>

      <Section label={t("filters.titleType")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          {TITLE_TYPES.map((title) => {
            const on = f.titles.includes(title);
            return (
              <label key={title} className="chip chip-toggle" title={t(`titleType.${title}Hint`)}>
                <input type="checkbox" name="title" value={title} defaultChecked={on}
                       style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} />
                {t(`titleType.${title}`)}
              </label>
            );
          })}
        </div>
      </Section>

      <Section label={t("filters.confirmedWithin")}>
        <select className="field" name="fresh" defaultValue={f.confirmedWithin ?? ""}
                aria-label={t("filters.confirmedWithin")}>
          <option value="">{t("common.any")}</option>
          {[7, 14, 30, 45].map((n) => (
            <option key={n} value={n}>{n} {t("filters.days")}</option>
          ))}
        </select>
      </Section>

      <Section label={t("filters.amenities")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          <label className="chip chip-toggle">
            <input type="checkbox" name="furnished" value="1" defaultChecked={f.furnished}
                   style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} />
            {t("filters.furnished")}
          </label>
          {AMENITIES.map((a) => {
            const on = f.amenities.includes(a);
            return (
              <label key={a} className="chip chip-toggle">
                <input type="checkbox" name="amenity" value={a} defaultChecked={on}
                       style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} />
                {t(`amenity.${a}`)}
              </label>
            );
          })}
        </div>
      </Section>

      <div style={{ display: "flex", gap: "0.5rem", position: "sticky", bottom: 0,
                    background: "var(--color-surface)", paddingTop: "0.5rem" }}>
        <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
          {t("filters.apply")}
        </button>
        <Link href={`/${locale}/search${f.transaction === "rent" ? "?txn=rent" : ""}`}
              className="btn btn-outline">
          {t("filters.reset")}
        </Link>
      </div>
    </form>
  );
}
