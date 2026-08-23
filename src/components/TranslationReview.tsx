import { formatDate } from "@/lib/format";
import { LOCALES, type Locale, type Translator } from "@/lib/i18n";

export interface PendingTranslation {
  id: string;
  reference: string;
  agency: string;
  sourceLang: string;
  description: Record<string, string>;
  translatedAt: string;
}

/**
 * Relecture humaine des traductions, réservée aux annonces premium (§4.1).
 * Les quatre langues sont montrées côte à côte, la source repérée : ce qu'on
 * relit, c'est la fidélité, pas le style.
 */
export function TranslationReview({
  items, locale, t, action,
}: {
  items: PendingTranslation[];
  locale: Locale;
  t: Translator;
  action: (form: FormData) => void;
}) {
  if (items.length === 0) {
    return <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>
      {t("backoffice.translationsEmpty")}
    </p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
      {items.map((item) => (
        <details key={item.id} style={{
          border: "1px solid var(--color-line)", borderRadius: "0.625rem", padding: "0.75rem",
        }}>
          <summary style={{ cursor: "pointer", display: "flex", gap: "0.5rem",
                            alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "0.875rem" }}>{item.reference}</strong>
            <span className="chip" style={{
              background: "var(--color-gold-soft)", color: "var(--color-gold)",
            }}>
              {item.sourceLang.toUpperCase()} → 4
            </span>
            <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)" }}>
              {item.agency} · {formatDate(item.translatedAt, locale)}
            </span>
          </summary>

          <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem" }}>
            {LOCALES.map((lang) => {
              const isSource = lang === item.sourceLang;
              return (
                <div key={lang} lang={lang === "zh" ? "zh-Hans" : lang} style={{
                  borderInlineStart: `3px solid ${isSource ? "var(--color-brand)" : "var(--color-line)"}`,
                  paddingInlineStart: "0.625rem",
                }}>
                  <div style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)",
                                fontWeight: 700, textTransform: "uppercase" }}>
                    {lang}
                    {isSource && ` · ${t("backoffice.translationSource")}`}
                  </div>
                  <p style={{ fontSize: "0.875rem", lineHeight: 1.6 }}>
                    {item.description?.[lang] ?? "—"}
                  </p>
                </div>
              );
            })}
          </div>

          <form action={action} style={{ marginTop: "0.75rem" }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="listing_id" value={item.id} />
            <button className="btn btn-primary"
                    style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem" }}>
              ✓ {t("backoffice.translationApprove")}
            </button>
          </form>
        </details>
      ))}
    </div>
  );
}
