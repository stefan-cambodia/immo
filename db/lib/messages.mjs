/**
 * Accès aux messages traduits depuis les jobs Node.
 *
 * Les textes des alertes (objet du mail, corps du message Telegram) vivent dans
 * `messages/*.json`, au même endroit que ceux de l'application : un seul
 * fichier par langue, relu par le traducteur. Ce module reproduit la sémantique
 * de `src/lib/i18n.ts` — repli sur l'anglais, substitution `{var}`, accord en
 * nombre de `src/lib/message-format.ts` — pour que la même clé donne le même
 * texte, que l'envoi parte de l'application ou du job.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES = ["fr", "en", "zh", "km", "ru"];
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
    return formatMessage(value, vars, lang);
  };
  t.locale = lang;
  return t;
}

// Copie de `src/lib/message-format.ts`, que les jobs ne peuvent pas importer :
// le commentaire de là-bas fait foi pour la syntaxe.
const PLURAL = /\{(\w+), plural,((?:\s*\w+\s*\{[^{}]*\})+)\s*\}/g;
const BRANCH = /(\w+)\s*\{([^{}]*)\}/g;
const rules = new Map();

function countOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

/** Substitution `{var}` et accord `{n, plural, one {…} few {…} many {…} other {…}}`. */
export function formatMessage(template, vars, lang) {
  if (!vars) return template;
  return template
    .replace(PLURAL, (block, name, body) => {
      const raw = vars[name];
      const n = countOf(raw);
      if (n === null) return block;
      if (!rules.has(lang)) rules.set(lang, new Intl.PluralRules(lang));
      const forms = {};
      for (const [, cat, text] of body.matchAll(BRANCH)) forms[cat] = text;
      return (forms[rules.get(lang).select(n)] ?? forms.other ?? "").replace(/#/g, String(raw));
    })
    .replace(/\{(\w+)\}/g, (_, v) => (vars[v] !== undefined ? String(vars[v]) : `{${v}}`));
}

/** Valeur d'un champ JSONB i18n avec repli, comme `i18nField` côté application. */
export function i18nField(field, locale) {
  if (!field) return "";
  return field[locale] || field.en || field.fr || Object.values(field)[0] || "";
}
