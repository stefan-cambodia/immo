import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { Locale, Translator } from "@/lib/i18n";

// La forme des lignes est définie par la couche d'accès, pour que l'affichage
// et l'export portent sur exactement le même enregistrement.
import type { AuditRecord } from "@/lib/audit";

export type AuditRow = AuditRecord;

const ACTION_TONE: Record<string, string> = {
  dedup_merged: "var(--color-danger)",
  dedup_distinct: "var(--color-ink-soft)",
  property_created: "var(--color-brand)",
  listing_confirmed: "var(--color-fresh)",
  alias_added: "var(--color-gold)",
  sign_in: "var(--color-ink-faint)",
  sign_out: "var(--color-ink-faint)",
};

/** Résumé lisible d'une entrée, dérivé du contenu de `details`. */
function summarise(row: AuditRow, t: Translator): string | null {
  const d = row.details ?? {};
  switch (row.action) {
    case "dedup_merged": {
      const moved = `${d.removedReference} → ${d.keptReference} · ${d.listingsMoved} ${t("home.statListings")}`;
      // Une fusion qui a détruit des annonces doit le dire, sans avoir à
      // déplier le détail JSON.
      return Number(d.listingsDropped) > 0
        ? `${moved} · −${d.listingsDropped}`
        : moved;
    }
    case "dedup_distinct":
      return `${Math.round(Number(d.score ?? 0) * 100)} %`;
    case "property_created":
      return [d.agency, d.priceUsd ? `$${Number(d.priceUsd).toLocaleString("en-US")}` : null]
        .filter(Boolean).join(" · ");
    case "listing_confirmed":
      return String(d.agency ?? "");
    case "alias_added":
      return `« ${d.term} » → ${row.targetLabel}`;
    default:
      return null;
  }
}

export function AuditLog({
  rows, locale, t,
}: { rows: AuditRow[]; locale: Locale; t: Translator }) {
  if (rows.length === 0) {
    return <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>{t("backoffice.auditEmpty")}</p>;
  }

  return (
    <ol style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((row) => {
        const summary = summarise(row, t);
        const linkable = row.targetType === "property" || row.targetType === "listing";
        return (
          <li key={row.id} style={{
            display: "flex", gap: "0.75rem", alignItems: "start",
            padding: "0.5rem 0", borderTop: "1px solid var(--color-line-soft)",
          }}>
            <span aria-hidden style={{
              width: 7, height: 7, borderRadius: 999, flexShrink: 0, marginTop: "0.4375rem",
              background: ACTION_TONE[row.action] ?? "var(--color-ink-faint)",
            }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", gap: "0.375rem", alignItems: "baseline", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "0.875rem", color: ACTION_TONE[row.action] ?? "inherit" }}>
                  {t(`auditAction.${row.action}`)}
                </strong>
                {row.targetLabel && (
                  linkable && row.action === "property_created" ? (
                    <Link href={`/${locale}/property/${row.targetLabel}`}
                          style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                      {row.targetLabel}
                    </Link>
                  ) : (
                    <code style={{ fontSize: "0.75rem", color: "var(--color-ink-soft)" }}>
                      {row.targetLabel}
                    </code>
                  )
                )}
              </div>
              {summary && (
                <div style={{ fontSize: "0.75rem", color: "var(--color-ink-soft)",
                              lineHeight: 1.5, wordBreak: "break-word" }}>
                  {summary}
                </div>
              )}
              <div style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)", marginTop: "0.125rem" }}>
                {row.actorEmail}
                {row.actorAgency && ` · ${row.actorAgency}`}
                {" · "}
                {formatDate(row.createdAt, locale)}{" "}
                {new Date(row.createdAt).toLocaleTimeString(locale === "km" ? "km-KH" : locale, {
                  hour: "2-digit", minute: "2-digit",
                })}
                {row.ip && ` · ${row.ip}`}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
