import type { Locale } from "./i18n";

// §2 principe 6 : USD par défaut, KHR en affichage secondaire.
export const KHR_PER_USD = 4100;

const LOCALE_TAG: Record<Locale, string> = {
  fr: "fr-FR",
  en: "en-US",
  zh: "zh-CN",
  km: "km-KH",
  ru: "ru-RU",
};

export function formatUsd(value: number | string, locale: Locale, compact = false): string {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: compact && n >= 100_000 ? "compact" : "standard",
  }).format(n);
}

export function formatKhr(usd: number | string, locale: Locale): string {
  const n = (typeof usd === "string" ? Number(usd) : usd) * KHR_PER_USD;
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n) + " ៛";
}

export function formatNumber(value: number | string, locale: Locale): string {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat(LOCALE_TAG[locale], { maximumFractionDigits: 0 }).format(n);
}

/** Pourcentage à une décimale, à la typographie de la langue : « 8,7 % » en
 *  français et en russe, « 8.7% » en anglais. `toFixed` écrivait « 8.7 % »
 *  partout. Prend un pourcentage (8.7), pas un ratio. */
export function formatPercent(pct: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(pct / 100);
}

/** Deux-points d'un libellé : l'espace qui le précède est une règle française,
 *  pas une règle universelle — « yield : 8.7% » est faux en anglais. */
export function colon(locale: Locale): string {
  return locale === "fr" ? "\u00a0: " : ": ";
}

export function formatDate(value: string | Date, locale: Locale): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { dateStyle: "medium" }).format(d);
}

export function daysSince(value: string | Date): number {
  const d = typeof value === "string" ? new Date(value) : value;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

export function daysUntil(value: string | Date): number {
  const d = typeof value === "string" ? new Date(value) : value;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

/** Palier de fraîcheur affiché publiquement (§1.3, §6.3). */
export function freshnessTier(lastConfirmed: string | Date): "fresh" | "aging" | "stale" {
  const d = daysSince(lastConfirmed);
  if (d <= 7) return "fresh";
  if (d <= 30) return "aging";
  return "stale";
}
