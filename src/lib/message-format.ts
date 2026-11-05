/**
 * Mise en forme d'un message traduit : substitution `{var}` et accord en
 * nombre.
 *
 * Le russe a imposé l'accord. « {n} agences » se contente d'une forme en
 * français, en anglais, et d'aucune en chinois ou en khmer ; le russe en veut
 * trois — 1 агентство, 2 агентства, 5 агентств — et la bonne dépend du
 * dernier chiffre (21 reprend la forme de 1, 11 celle de 5). Aucune chaîne
 * unique ne tient.
 *
 * La syntaxe est un sous-ensemble de la forme ICU, assez pour cela :
 *
 *   {n, plural, one {# спальня} few {# спальни} many {# спален} other {# спальни}}
 *
 * La catégorie vient d'`Intl.PluralRules` pour la langue ; `#` reçoit la
 * valeur telle que l'appelant l'a passée — déjà formatée s'il l'a formatée,
 * le nombre étant relu dans ses chiffres. Une branche ne contient pas
 * d'accolade. Une valeur absente ou sans chiffre laisse le bloc intact : c'est
 * ce qui permet de passer un gabarit au navigateur (`{ n: "{n}" }`), qui
 * l'accorde lui-même une fois le nombre connu.
 *
 * Pur, sans code serveur : la carte l'importe côté navigateur.
 * `db/lib/messages.mjs` en garde une copie pour les jobs Node.
 */

export type MessageVars = Record<string, string | number>;

const PLURAL = /\{(\w+), plural,((?:\s*\w+\s*\{[^{}]*\})+)\s*\}/g;
const BRANCH = /(\w+)\s*\{([^{}]*)\}/g;

const rules = new Map<string, Intl.PluralRules>();

function category(lang: string, n: number): string {
  let r = rules.get(lang);
  if (!r) {
    r = new Intl.PluralRules(lang);
    rules.set(lang, r);
  }
  return r.select(n);
}

/** Le nombre qu'une valeur porte, formatée ou non ; `null` s'il n'y en a pas. */
function countOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

export function formatMessage(template: string, vars: MessageVars | undefined, lang: string): string {
  if (!vars) return template;
  return template
    .replace(PLURAL, (block, name: string, body: string) => {
      const raw = vars[name];
      const n = countOf(raw);
      if (n === null) return block;
      const forms: Record<string, string> = {};
      for (const [, cat, text] of body.matchAll(BRANCH)) forms[cat] = text;
      return (forms[category(lang, n)] ?? forms.other ?? "").replace(/#/g, String(raw));
    })
    .replace(/\{(\w+)\}/g, (_, v: string) => (vars[v] !== undefined ? String(vars[v]) : `{${v}}`));
}
