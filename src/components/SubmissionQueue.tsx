import type { Locale, Translator } from "@/lib/i18n";
import { formatDate, formatUsd } from "@/lib/format";
import { PinPicker } from "./PinPicker";

/** Champs de la charge normalisée réellement affichés par la file. */
interface NormalizedSubmission {
  propertyType?: string;
  transactionType?: string;
  priceUsd?: number | string;
  bedrooms?: number;
  indoorAreaSqm?: number;
  landAreaSqm?: number;
  floor?: number;
  titleType?: string;
  address?: string;
  payload?: { address?: string };
}

export interface PendingSubmission {
  id: string;
  source: string;
  externalRef: string | null;
  agency: string;
  normalized: NormalizedSubmission & Record<string, unknown>;
  locationName: Record<string, string> | null;
  createdAt: string;
}

/**
 * File des soumissions en attente de pin (§6.1).
 *
 * Un flux d'agence peut apporter tous les champs et n'avoir qu'une adresse
 * texte. Elle n'est jamais géocodée : la soumission attend ici qu'un humain
 * pointe le bien sur la carte.
 */
export function SubmissionQueue({
  items, locale, t, provider, action,
}: {
  items: PendingSubmission[];
  locale: Locale;
  t: Translator;
  provider: { style: string | Record<string, unknown>; attribution: string; maxZoom: number };
  action: (form: FormData) => void;
}) {
  if (items.length === 0) {
    return <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>
      {t("backoffice.submissionsEmpty")}
    </p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {items.map((s) => {
        const n = s.normalized ?? {};
        const area = n.indoorAreaSqm ?? n.landAreaSqm;
        return (
          <details key={s.id} style={{
            border: "1px solid var(--color-line)", borderRadius: "0.625rem", padding: "0.75rem",
          }}>
            <summary style={{ cursor: "pointer", display: "flex", gap: "0.5rem",
                              alignItems: "center", flexWrap: "wrap" }}>
              <span className="chip" style={{
                background: "var(--color-stale-soft)", color: "var(--color-stale)",
              }}>
                {t("backoffice.submissionSource")} {s.source}
              </span>
              <strong style={{ fontSize: "0.875rem" }}>{s.externalRef ?? s.id.slice(0, 8)}</strong>
              <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)" }}>
                {s.agency} · {formatDate(s.createdAt, locale)}
              </span>
            </summary>

            <dl style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(8rem, 1fr))",
              gap: "0.5rem 1rem", margin: "0.75rem 0", fontSize: "0.8125rem",
            }}>
              {[
                [t("filters.propertyType"), n.propertyType && t(`propertyType.${n.propertyType}`)],
                [t("filters.transaction"), n.transactionType && t(n.transactionType === "rent" ? "common.forRent" : "common.forSale")],
                [t("filters.priceRange"), n.priceUsd && formatUsd(n.priceUsd, locale)],
                [t("common.bedrooms"), n.bedrooms || null],
                [t("property.indoorArea"), area ? `${area} ${t("common.sqm")}` : null],
                [t("common.floor"), n.floor ?? null],
                [t("filters.titleType"), n.titleType && t(`titleType.${n.titleType}`)],
              ].filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
                <div key={String(k)}>
                  <dt style={{ color: "var(--color-ink-faint)", fontSize: "0.6875rem" }}>{k}</dt>
                  <dd style={{ fontWeight: 600 }}>{String(v)}</dd>
                </div>
              ))}
            </dl>

            {/* L'adresse est affichée pour aider la pose du pin — elle n'est
                jamais convertie en coordonnées par le système. */}
            {s.normalized?.address || s.normalized?.payload?.address ? (
              <p style={{ fontSize: "0.75rem", color: "var(--color-ink-soft)", marginBottom: "0.5rem" }}>
                {String(s.normalized.address ?? "")}
              </p>
            ) : null}

            <form action={action}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="submission_id" value={s.id} />
              <PinPicker
                style={provider.style}
                attribution={provider.attribution}
                maxZoom={provider.maxZoom}
                center={[104.916, 11.5564]}
                zoom={13}
                labels={{
                  required: t("backoffice.pinRequired"),
                  hint: t("backoffice.pinRequiredHint"),
                  done: t("backoffice.pinSet"),
                  submit: t("backoffice.submissionPin"),
                }}
              />
            </form>
          </details>
        );
      })}
    </div>
  );
}
