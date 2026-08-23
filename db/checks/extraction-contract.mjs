#!/usr/bin/env node
/**
 * Vérifie la requête que l'extracteur enverrait, et la façon dont il lit la
 * réponse — sans appeler l'API ni consommer de jeton.
 *
 * Ce n'est pas un test de la qualité d'extraction, qui demanderait de vraies
 * clés : c'est un test du contrat. Il attrape les erreurs qu'on ne voit
 * qu'en production autrement — mauvais identifiant de modèle, outil non
 * strict, paramètre de réflexion invalide sur les modèles récents.
 */
import Anthropic from "@anthropic-ai/sdk";
import { extractListing, MODEL } from "../lib/extract.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

let captured = null;
const reply = (content, extra = {}) => ({
  ok: true, status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => ({
    id: "msg_test", type: "message", role: "assistant", model: MODEL,
    content, stop_reason: "tool_use", stop_details: null,
    usage: { input_tokens: 120, output_tokens: 80 }, ...extra,
  }),
  text: async () => "",
});

const fakeFetch = async (url, init) => {
  captured = { url: String(url), body: JSON.parse(init.body) };
  return reply([{ type: "tool_use", id: "tu_1", name: "record_listing", input: {
    property_type: "condo", transaction_type: "sale", price_usd: 185000,
    negotiable: true, area_name: "BKK1", building_name: null, bedrooms: 2,
    bathrooms: 2, indoor_area_sqm: 72, land_area_sqm: null, floor: 14,
    unit_number: null, title_type: "strata", furnished: false, year_built: null,
    description: "2BR condo", source_lang: "en", missing: [],
  } }]);
};

const client = new Anthropic({ apiKey: "test-key", fetch: fakeFetch });

console.log("Contrat de la requête d'extraction");
const fields = await extractListing("2BR condo BKK1 14th floor 72sqm strata 185k nego", { client });

const b = captured.body;
check("appelle /v1/messages", captured.url.includes("/v1/messages"), captured.url);
check(`modèle ${MODEL}`, b.model === MODEL, b.model);
check("réflexion adaptative", b.thinking?.type === "adaptive", JSON.stringify(b.thinking));
check("pas de budget_tokens (retiré sur les modèles récents)",
      b.thinking?.budget_tokens === undefined, JSON.stringify(b.thinking));
check("pas de temperature ni top_p (retirés)",
      b.temperature === undefined && b.top_p === undefined);
check("max_tokens généreux", b.max_tokens >= 4096, String(b.max_tokens));
check("un seul outil déclaré", b.tools?.length === 1, String(b.tools?.length));
check("outil strict", b.tools?.[0]?.strict === true, String(b.tools?.[0]?.strict));
check("schéma fermé", b.tools[0].input_schema.additionalProperties === false);
check("tous les champs requis", b.tools[0].input_schema.required.length === 18,
      String(b.tools[0].input_schema.required.length));
check("outil forcé", b.tool_choice?.type === "tool" && b.tool_choice?.name === "record_listing",
      JSON.stringify(b.tool_choice));
check("consigne de marché dans le système",
      b.system.includes("185k") && b.system.includes("borey"), "");
check("pas de préremplissage assistant",
      b.messages.every((m) => m.role === "user"), JSON.stringify(b.messages.map((m) => m.role)));

console.log("\nLecture de la réponse");
check("champs extraits renvoyés", fields.price_usd === 185000 && fields.area_name === "BKK1",
      JSON.stringify({ p: fields.price_usd, a: fields.area_name }));
check("l'usage est remonté", fields._usage?.input_tokens === 120);

console.log("\nCas d'erreur");
const refusing = new Anthropic({ apiKey: "k", fetch: async () => reply([], {
  stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "non" } }) });
try {
  await extractListing("…", { client: refusing });
  check("un refus lève une erreur", false, "aucune erreur levée");
} catch (err) {
  check("un refus lève une erreur", err.message.includes("refus"), err.message);
}

const silent = new Anthropic({ apiKey: "k", fetch: async () => reply([{ type: "text", text: "je ne sais pas" }]) });
try {
  await extractListing("…", { client: silent });
  check("réponse sans appel d'outil → erreur", false, "aucune erreur levée");
} catch (err) {
  check("réponse sans appel d'outil → erreur",
        err.message.includes("record_listing"), err.message);
}

console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
