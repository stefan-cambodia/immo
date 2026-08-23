#!/usr/bin/env node
/**
 * Vérifie le contrat de la requête de traduction et le comportement de la
 * file, sans clé d'API : client HTTP doublé, traducteur injecté, transaction
 * annulée.
 */
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import { translateDescription, translateQueue, MODEL, LOCALES } from "../lib/translate.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  ok ? pass++ : fail++;
};

// ------------------------------------------------------- contrat de requête
let captured = null;
const reply = (content, extra = {}) => ({
  ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
  json: async () => ({ id: "msg", type: "message", role: "assistant", model: MODEL,
    content, stop_reason: "tool_use", stop_details: null,
    usage: { input_tokens: 90, output_tokens: 140 }, ...extra }),
  text: async () => "",
});
const TRANSLATIONS = {
  fr: "Villa à louer à Teuk Thla, 5 chambres, 508 m².",
  en: "Villa for rent in Teuk Thla, 5 bedrooms, 508 sqm.",
  zh: "Teuk Thla 别墅出租，5 房，508 平方米。",
  km: "វីឡាសម្រាប់ជួលនៅទឹកថ្លា បន្ទប់គេង ៥ ទំហំ ៥០៨ ម២។",
};
const client = new Anthropic({ apiKey: "k", fetch: async (url, init) => {
  captured = { url: String(url), body: JSON.parse(init.body) };
  return reply([{ type: "tool_use", id: "t", name: "record_translations", input: TRANSLATIONS }]);
} });

console.log("Contrat de la requête de traduction");
const out = await translateDescription("Villa for rent in Teuk Thla, 5 bedrooms, 508 sqm.", "en", { client });
const b = captured.body;
check(`modèle ${MODEL}`, b.model === MODEL, b.model);
check("effort bas — la traduction n'est pas du raisonnement",
      b.output_config?.effort === "low", JSON.stringify(b.output_config));
check("outil strict", b.tools?.[0]?.strict === true);
check("les quatre langues sont requises",
      b.tools[0].input_schema.required.join(",") === "fr,en,zh,km",
      b.tools[0].input_schema.required.join(","));
check("outil forcé", b.tool_choice?.name === "record_translations");
check("la langue source est annoncée au modèle",
      b.messages[0].content.includes("anglais"), b.messages[0].content.slice(0, 40));
check("consigne de non-embellissement",
      b.system.includes("n'embellis pas") || b.system.includes("Traduis, n'embellis"), "");
check("termes de marché préservés",
      b.system.includes("borey") && b.system.includes("strata"), "");
check("les quatre langues sont renvoyées",
      LOCALES.every((l) => out[l]), JSON.stringify(Object.keys(out)));

console.log("\nCas d'erreur");
for (const [label, content, extra, expect] of [
  ["refus", [], { stop_reason: "refusal", stop_details: { explanation: "non" } }, "refus"],
  ["aucun appel d'outil", [{ type: "text", text: "…" }], {}, "record_translations"],
  ["langue manquante", [{ type: "tool_use", id: "t", name: "record_translations",
      input: { ...TRANSLATIONS, km: "" } }], {}, "manquantes"],
]) {
  const c = new Anthropic({ apiKey: "k", fetch: async () => reply(content, extra) });
  try {
    await translateDescription("texte", "en", { client: c });
    check(`${label} → erreur`, false, "aucune erreur levée");
  } catch (err) { check(`${label} → erreur`, err.message.includes(expect), err.message); }
}
try {
  await translateDescription("   ", "en", { client });
  check("description vide → erreur", false, "aucune erreur");
} catch (err) { check("description vide → erreur", err.message.includes("vide"), err.message); }

// ------------------------------------------------------------- la file
console.log("\nComportement de la file");
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();
await db.query("BEGIN");

await db.query(`UPDATE listings SET translation_status = 'pending'`);
// Une annonce sans description : elle doit sortir de la file définitivement.
const { rows: [empty] } = await db.query(
  `UPDATE listings SET description_i18n = '{}'::jsonb
   WHERE id = (SELECT id FROM listings LIMIT 1) RETURNING id`);
// Une annonce d'agence premium, pour vérifier la priorité.
const { rows: [prem] } = await db.query(
  `SELECT l.id, l.description_source_lang::text AS lang FROM listings l
   JOIN agencies a ON a.id = l.agency_id
   WHERE a.subscription_tier = 'premium' AND l.description_i18n <> '{}'::jsonb LIMIT 1`);

let seen = [];
const fakeTranslate = async (text, lang) => {
  seen.push({ text, lang });
  return { fr: "FR:" + text, en: "EN:" + text, zh: "ZH:" + text, km: "KM:" + text };
};

const s1 = await translateQueue(db, { translate: fakeTranslate, limit: 5 });
check("l'annonce sans description est écartée", s1.skipped >= 1, String(s1.skipped));
check("cinq annonces traduites", s1.translated === 5, String(s1.translated));
const { rows: [emptyRow] } = await db.query(
  `SELECT translation_status FROM listings WHERE id = $1`, [empty.id]);
check("elle passe en not_needed", emptyRow.translation_status === "not_needed",
      emptyRow.translation_status);

const { rows: [done] } = await db.query(
  `SELECT description_i18n AS d, description_source_lang::text AS lang,
          translation_status, machine_translated, translated_at
   FROM listings WHERE translation_status = 'machine' LIMIT 1`);
check("les quatre langues sont remplies",
      LOCALES.every((l) => done.d[l]), JSON.stringify(Object.keys(done.d)));
check("le texte source est conservé mot pour mot",
      !String(done.d[done.lang]).startsWith(done.lang.toUpperCase() + ":"),
      String(done.d[done.lang]).slice(0, 30));
check("machine_translated suit l'état", done.machine_translated === true);
check("translated_at est horodaté", Boolean(done.translated_at));

// Priorité premium : la première traduite doit être une premium.
const { rows: [firstTier] } = await db.query(
  `SELECT a.subscription_tier::text AS tier FROM listings l
   JOIN agencies a ON a.id = l.agency_id
   WHERE l.translation_status = 'machine' ORDER BY l.translated_at LIMIT 1`);
check("les agences premium passent devant", firstTier.tier === "premium", firstTier.tier);

// Échec : l'annonce est marquée, pas perdue.
const failing = async () => { throw new Error("API indisponible"); };
const s2 = await translateQueue(db, { translate: failing, limit: 2 });
check("un échec est compté", s2.failed === 2, String(s2.failed));
const { rows: [failed] } = await db.query(
  `SELECT translation_status, translation_error FROM listings
   WHERE translation_status = 'failed' LIMIT 1`);
check("l'erreur est conservée", failed.translation_error.includes("indisponible"),
      failed.translation_error);
await translateQueue(db, { translate: fakeTranslate, limit: 50 });
const stillFailed = (await db.query(
  `SELECT count(*)::int n FROM listings WHERE translation_status='failed'`)).rows[0].n;
check("les échecs ne sont pas repris par défaut", stillFailed === 2, String(stillFailed));
const s4 = await translateQueue(db, { translate: fakeTranslate, limit: 50, retry: true });
check("--retry les reprend", (await db.query(
  `SELECT count(*)::int n FROM listings WHERE translation_status='failed'`)).rows[0].n === 0,
  String(s4.failed));

await db.query("ROLLBACK");
await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
