#!/usr/bin/env node
/**
 * Vérifie les fichiers de messages : parité des clés entre les langues,
 * mêmes variables d'une langue à l'autre, accords en nombre complets — et
 * que les deux copies du formateur (application, jobs) rendent le même texte.
 *
 * Sans base ni serveur : ce sont des fichiers. Une clé oubliée ne casse rien
 * de visible — la fiche retombe sur l'anglais — et c'est bien pour cela
 * qu'il faut la chercher : rien d'autre ne la signalera.
 *
 *   node db/checks/messages.mjs
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, formatMessage as jobFormat } from "../lib/messages.mjs";
// Node lit le TypeScript sans compilation (effacement des types) : c'est le
// formateur même que charge l'application, pas une réécriture.
import { formatMessage as appFormat } from "../../src/lib/message-format.ts";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const here = dirname(fileURLToPath(import.meta.url));
const messages = {};
for (const l of LOCALES) {
  messages[l] = JSON.parse(await readFile(join(here, "..", "..", "messages", `${l}.json`), "utf8"));
}
const flat = (m) => Object.entries(m).flatMap(([g, keys]) =>
  Object.entries(keys).map(([k, v]) => [`${g}.${k}`, v]));

const PLURAL = /\{(\w+), plural,((?:\s*\w+\s*\{[^{}]*\})+)\s*\}/g;
/** Variables d'un message : `{x}` simples et `{x, plural, …}`. */
function variables(text) {
  const names = new Set();
  for (const [, n] of text.matchAll(PLURAL)) names.add(n);
  for (const [, n] of text.replace(PLURAL, "").matchAll(/\{(\w+)\}/g)) names.add(n);
  return [...names].sort().join(",");
}

// --------------------------------------------------------------- parité
console.log("Parité des clés et des variables (référence : en)");
const reference = new Map(flat(messages.en));
for (const l of LOCALES.filter((x) => x !== "en")) {
  const own = new Map(flat(messages[l]));
  const missing = [...reference.keys()].filter((k) => !own.has(k));
  const extra = [...own.keys()].filter((k) => !reference.has(k));
  check(`${l} : ${own.size} clés, aucune manquante`, missing.length === 0, missing.slice(0, 5).join(", "));
  check(`${l} : aucune clé en trop`, extra.length === 0, extra.slice(0, 5).join(", "));
  const drift = [...own].filter(([k, v]) => reference.has(k)
    && variables(v) !== variables(reference.get(k)));
  check(`${l} : mêmes variables que l'anglais`, drift.length === 0,
    drift.slice(0, 3).map(([k, v]) => `${k} {${variables(v)}} ≠ {${variables(reference.get(k))}}`).join(" ; "));
}

// ----------------------------------------------------- accords en nombre
// Toute catégorie qu'un ENTIER peut atteindre dans la langue doit avoir sa
// branche : un « few » russe absent retomberait sur « other », la forme des
// fractions. `other` est exigé partout, c'est le repli.
console.log("\nAccords en nombre");
for (const l of LOCALES) {
  const rules = new Intl.PluralRules(l);
  const needed = new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n)));
  const broken = [];
  let blocks = 0;
  for (const [key, text] of flat(messages[l])) {
    const unbalanced = text.replace(PLURAL, "").match(/\{\w+, plural/);
    if (unbalanced) broken.push(`${key} : bloc illisible`);
    for (const [, , body] of text.matchAll(PLURAL)) {
      blocks++;
      const cats = new Set([...body.matchAll(/(\w+)\s*\{/g)].map((m) => m[1]));
      const lacking = [...needed, "other"].filter((c) => !cats.has(c));
      if (lacking.length) broken.push(`${key} : sans ${lacking.join("/")}`);
    }
  }
  check(`${l} : ${blocks} bloc(s), toutes les catégories [${[...needed].join(", ")}]`,
    broken.length === 0, broken.slice(0, 4).join(" ; "));
}

// --------------------------------------------------------------- rendu
console.log("\nRendu russe");
const ru = messages.ru;
const nbsp = new Intl.NumberFormat("ru-RU").format(1234);   // « 1 234 », espace insécable
for (const [n, expected] of [
  [1, "1 спальня"], [2, "2 спальни"], [4, "4 спальни"], [5, "5 спален"],
  [11, "11 спален"], [12, "12 спален"], [14, "14 спален"], [21, "21 спальня"],
  [22, "22 спальни"], [25, "25 спален"], [111, "111 спален"], [nbsp, `${nbsp} спальни`],
]) {
  const got = appFormat(ru.common.bedroomCount, { n }, "ru");
  check(`${JSON.stringify(n)} → ${expected}`, got === expected, got);
}
const tpl = ru.property.agencyCountShort;
check("gabarit passé au navigateur : bloc laissé intact",
  appFormat(tpl, { n: "{n}" }, "ru") === tpl, appFormat(tpl, { n: "{n}" }, "ru"));
check("puis accordé une fois le nombre connu",
  appFormat(appFormat(tpl, { n: "{n}" }, "ru"), { n: 3 }, "ru") === "3 агентства");
check("deux blocs dans une phrase",
  appFormat(ru.landing.intro, { count: 21, agencies: 3, median: "$1", perMonth: "" }, "ru")
    === "21 объект от 3 агентств. Медианная цена $1.");
check("le français accorde aussi : « 1 Chambre »",
  appFormat(messages.fr.common.bedroomCount, { n: 1 }, "fr") === "1 Chambre");

// ------------------------------------------------- les deux formateurs
console.log("\nApplication et jobs rendent le même texte");
const diffs = [];
for (const l of LOCALES) {
  for (const [key, text] of flat(messages[l])) {
    const vars = Object.fromEntries(variables(text).split(",").filter(Boolean).map((v) => [v, 7]));
    for (const n of [1, 3, 7, 21, "{n}"]) {
      if ("n" in vars) vars.n = n;
      if (appFormat(text, vars, l) !== jobFormat(text, vars, l)) diffs.push(`${l}.${key}`);
    }
  }
}
check("src/lib/message-format.ts ≡ db/lib/messages.mjs", diffs.length === 0, diffs.slice(0, 5).join(", "));

console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
