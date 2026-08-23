import { formatDate, formatNumber } from "@/lib/format";
import type { Locale, Translator } from "@/lib/i18n";
import { AUDIT_ACTIONS, auditFiltersToQuery, type AuditFilters, type AuditRecord } from "@/lib/audit";
import { AuditLog } from "./AuditLog";

/**
 * Consultation, filtrage et export du journal. Le formulaire est un GET
 * ordinaire : les filtres se partagent par URL, et l'export reprend exactement
 * la même requête que ce qui est affiché.
 */
export function AuditPanel({
  rows, total, span, filters, locale, t,
}: {
  rows: AuditRecord[];
  total: number;
  span: { total: number; oldest: string | null; newest: string | null; purges: number };
  filters: AuditFilters;
  locale: Locale;
  t: Translator;
}) {
  const qs = auditFiltersToQuery(filters);
  const exportHref = (format: "csv" | "jsonl") =>
    `/api/audit/export?${qs ? `${qs}&` : ""}format=${format}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
      <form
        action={`/${locale}/backoffice`}
        method="get"
        style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", alignItems: "end" }}
      >
        <label style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)", flex: "1 1 8rem" }}>
          {t("backoffice.auditFilters")}
          <select className="field" name="audit_action" defaultValue={filters.action ?? ""}
                  style={{ marginTop: "0.1875rem", fontSize: "0.8125rem", padding: "0.3125rem 0.5rem" }}>
            <option value="">{t("common.all")}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>{t(`auditAction.${a}`)}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)" }}>
          {t("backoffice.auditFrom")}
          <input className="field" type="date" name="audit_from" defaultValue={filters.from ?? ""}
                 style={{ marginTop: "0.1875rem", fontSize: "0.8125rem", padding: "0.25rem 0.5rem" }} />
        </label>
        <label style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)" }}>
          {t("backoffice.auditTo")}
          <input className="field" type="date" name="audit_to" defaultValue={filters.to ?? ""}
                 style={{ marginTop: "0.1875rem", fontSize: "0.8125rem", padding: "0.25rem 0.5rem" }} />
        </label>
        <label style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)", flex: "1 1 7rem" }}>
          {t("backoffice.auditActor")}
          <input className="field" type="search" name="audit_actor" defaultValue={filters.actor ?? ""}
                 placeholder="@" style={{ marginTop: "0.1875rem", fontSize: "0.8125rem", padding: "0.3125rem 0.5rem" }} />
        </label>
        <button className="btn btn-outline" style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem" }}>
          {t("filters.apply")}
        </button>
      </form>

      <div style={{
        display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap",
        fontSize: "0.75rem", color: "var(--color-ink-soft)",
      }}>
        <span>{t("backoffice.auditShowing", { shown: rows.length, total: formatNumber(total, locale) })}</span>
        <span style={{ marginInlineStart: "auto", display: "flex", gap: "0.375rem" }}>
          {/* L'export reprend le filtre courant, pas seulement les lignes affichées. */}
          <a className="btn btn-outline" href={exportHref("csv")} download
             style={{ padding: "0.25rem 0.625rem", fontSize: "0.75rem" }}>
            {t("backoffice.auditExport")} CSV
          </a>
          <a className="btn btn-outline" href={exportHref("jsonl")} download
             style={{ padding: "0.25rem 0.625rem", fontSize: "0.75rem" }}>
            JSONL
          </a>
        </span>
      </div>

      <AuditLog rows={rows} locale={locale} t={t} />

      <footer style={{
        borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.625rem",
        fontSize: "0.6875rem", color: "var(--color-ink-faint)", lineHeight: 1.6,
      }}>
        {span.oldest && span.newest && (
          <div>
            {t("backoffice.auditSpanLabel", {
              total: formatNumber(span.total, locale),
              oldest: formatDate(span.oldest, locale),
              newest: formatDate(span.newest, locale),
            })}
          </div>
        )}
        <div>
          {t("backoffice.auditPurgeCount", { n: span.purges })}
          {" · "}
          <code>{t("backoffice.auditRetentionNote")}</code>
        </div>
      </footer>
    </div>
  );
}
