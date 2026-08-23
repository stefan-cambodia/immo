/**
 * Accès aux messages traduits depuis les jobs Node.
 *
 * Les textes des alertes (objet du mail, corps du message Telegram) vivent dans
 * `messages/*.json`, au même endroit que ceux de l'application : un seul
 * fichier par langue, relu par le traducteur. Ce module reproduit la sémantique
 * de `src/lib/i18n.ts` — repli sur l'anglais, substitution `{var}` — pour que
 * la même clé donne le même texte, que l'envoi parte de l'application ou du
 * job.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES = ["fr", "en", "zh", "km"];
export const DEFAULT_LOCALE = "en";

const here = dirname(fileURLToPath(import.meta.url));
const cache = new Map();

async function load(locale) {
  if (!cache.has(locale)) {
    const raw = await readFile(join(here, "..", "..", "messages", `${locale}.json`), "utf8");
    cache.set(locale, JSON.parse(raw));
  }
  return cache.get(locale);
}

/** Traducteur `t(clé, variables)` pour une locale, avec repli sur l'anglais. */
export async function getTranslator(locale) {
  const lang = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const messages = await load(lang);
  const fallback = lang === DEFAULT_LOCALE ? null : await load(DEFAULT_LOCALE);

  const t = (key, vars) => {
    const [group, name] = key.split(".");
    const value = messages[group]?.[name] ?? fallback?.[group]?.[name];
    if (value === undefined) return key;
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (_, v) => (vars[v] !== undefined ? String(vars[v]) : `{${v}}`));
  };
  t.locale = lang;
  return t;
}

/** Valeur d'un champ JSONB i18n avec repli, comme `i18nField` côté application. */
export function i18nField(field, locale) {
  if (!field) return "";
  return field[locale] || field.en || field.fr || Object.values(field)[0] || "";
}
