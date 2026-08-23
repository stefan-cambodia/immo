import "server-only";
import { cache } from "react";

export const LOCALES = ["fr", "en", "zh", "km"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Correspondance locale → attribut `lang` HTML et `hreflang`. */
export const HTML_LANG: Record<Locale, string> = {
  fr: "fr",
  en: "en",
  zh: "zh-Hans",
  km: "km",
};

export type Messages = Record<string, Record<string, string>>;

const load = cache(async (locale: Locale): Promise<Messages> => {
  const mod = await import(`../../messages/${locale}.json`);
  return (mod.default ?? mod) as Messages;
});

export type Translator = ((key: string, vars?: Record<string, string | number>) => string) & {
  locale: Locale;
  raw: Messages;
};

export async function getTranslator(locale: Locale): Promise<Translator> {
  const messages = await load(locale);
  const fallback = locale === DEFAULT_LOCALE ? null : await load(DEFAULT_LOCALE);

  const t = ((key: string, vars?: Record<string, string | number>) => {
    const [group, name] = key.split(".");
    const value = messages[group]?.[name] ?? fallback?.[group]?.[name];
    if (value === undefined) return key;
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (_, v: string) =>
      vars[v] !== undefined ? String(vars[v]) : `{${v}}`
    );
  }) as Translator;

  t.locale = locale;
  t.raw = messages;
  return t;
}

/** Choisit la meilleure locale à partir de l'en-tête Accept-Language. */
export function negotiateLocale(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("km")) return "km";
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}

/** Extrait la valeur d'un champ JSONB i18n avec repli sur l'anglais. */
export function i18nField(
  field: Record<string, string> | null | undefined,
  locale: Locale
): string {
  if (!field) return "";
  return field[locale] || field.en || field.fr || Object.values(field)[0] || "";
}
