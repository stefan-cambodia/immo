import { daysSince, formatDate } from "@/lib/format";
import type { Locale, Translator } from "@/lib/i18n";

/** Fraîcheur affichée publiquement : deuxième différenciateur du portail (§1.3). */
export function FreshnessBadge({
  lastConfirmed, t, locale, withDate = false,
}: { lastConfirmed: string | Date; t: Translator; locale: Locale; withDate?: boolean }) {
  const d = daysSince(lastConfirmed);
  const tier = d <= 7 ? "fresh" : d <= 30 ? "aging" : "stale";
  const style = {
    fresh: { background: "var(--color-fresh-soft)", color: "var(--color-fresh)" },
    aging: { background: "var(--color-surface-alt)", color: "var(--color-ink-soft)" },
    stale: { background: "var(--color-stale-soft)", color: "var(--color-stale)" },
  }[tier];

  return (
    <span
      className="chip"
      style={style}
      title={`${t("property.lastConfirmed")} ${formatDate(lastConfirmed, locale)}`}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", flexShrink: 0 }} />
      {withDate
        ? `${t("property.lastConfirmed")} ${formatDate(lastConfirmed, locale)}`
        : d === 0
          ? t("property.confirmedToday")
          : t("property.confirmedDaysAgo", { n: d })}
    </span>
  );
}

/** Troisième différenciateur : la règle de propriété étrangère, en évidence (§5.3). */
export function ForeignEligibleBadge({ t }: { t: Translator }) {
  return (
    <span className="chip" style={{ background: "var(--color-brand-soft)", color: "var(--color-brand)" }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M2 8.5 6 12.5 14 3.5" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t("nav.foreignEligible")}
    </span>
  );
}

export function TitleBadge({ titleType, t }: { titleType: string; t: Translator }) {
  const strong = titleType === "hard" || titleType === "strata";
  return (
    <span
      className="chip"
      title={t(`titleType.${titleType}Hint`)}
      style={{
        background: strong ? "var(--color-surface-alt)" : "var(--color-danger-soft)",
        color: strong ? "var(--color-ink-soft)" : "var(--color-danger)",
      }}
    >
      {t(`titleType.${titleType}`)}
    </span>
  );
}

/** Phase 4 : le type de titre a été vérifié sur documents par un partenaire
 *  nommé. Le libellé complet (partenaire, date) est fourni par l'appelant. */
export function TitleVerifiedBadge({ t, hint }: { t: Translator; hint: string }) {
  return (
    <span className="chip" title={hint}
          style={{ background: "var(--color-fresh-soft)", color: "var(--color-fresh)" }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M8 1.5 13.5 3.5V7.5C13.5 11 11.2 13.5 8 14.5 4.8 13.5 2.5 11 2.5 7.5V3.5L8 1.5Z"
              stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M5.5 8 7.3 9.8 10.5 6" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t("titles.badge")}
    </span>
  );
}

/** « 5 agences proposent ce bien » — la proposition de valeur, visible partout. */
export function AgencyCountBadge({ count, t }: { count: number; t: Translator }) {
  if (count < 2) return null;
  return (
    <span className="chip" style={{ background: "var(--color-gold-soft)", color: "var(--color-gold)" }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M2 13V6.5L8 2.5l6 4V13M6 13V9.5h4V13" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t("property.agencyCountShort", { n: count })}
    </span>
  );
}
