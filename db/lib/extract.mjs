import Anthropic from "@anthropic-ai/sdk";

/**
 * Extraction des champs structurés depuis le message d'un agent (§6.1).
 *
 * L'agent écrit comme il parle, en anglais, en khmer ou en mélangeant les
 * deux : « 2BR condo BKK1 14th floor 72sqm strata title 185k nego ». Le rôle
 * du modèle est de transformer cela en champs typés, pas d'inventer ce qui
 * manque — un champ absent doit rester absent, c'est le bot qui le redemandera.
 *
 * L'outil est déclaré en `strict: true` : l'entrée renvoyée est garantie
 * conforme au schéma, ce qui évite d'écrire un validateur de secours pour du
 * JSON approximatif.
 */

export const MODEL = "claude-opus-5";

const PROPERTY_TYPES = ["condo", "borey_house", "villa", "flat_shophouse",
  "land", "commercial", "warehouse", "whole_building"];
const TITLE_TYPES = ["hard", "soft", "strata", "unknown"];

const EXTRACT_TOOL = {
  name: "record_listing",
  description:
    "Enregistre les champs d'une annonce immobilière extraits du message d'un agent. "
    + "N'inclure un champ que s'il est explicitement présent ou déductible sans ambiguïté. "
    + "Ne jamais deviner un prix, une surface ou un type de titre.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      property_type: { type: ["string", "null"], enum: [...PROPERTY_TYPES, null] },
      transaction_type: { type: ["string", "null"], enum: ["sale", "rent", null] },
      price_usd: { type: ["number", "null"] },
      negotiable: { type: ["boolean", "null"] },
      area_name: {
        type: ["string", "null"],
        description: "Quartier, commune ou ville tels que nommés par l'agent, "
          + "sans normalisation : « BKK1 », « Toul Kork », « ភ្នំពេញ », « 西港 ».",
      },
      building_name: { type: ["string", "null"] },
      bedrooms: { type: ["integer", "null"] },
      bathrooms: { type: ["integer", "null"] },
      indoor_area_sqm: { type: ["number", "null"] },
      land_area_sqm: { type: ["number", "null"] },
      floor: { type: ["integer", "null"], description: "0 pour un rez-de-chaussée." },
      unit_number: { type: ["string", "null"] },
      title_type: { type: ["string", "null"], enum: [...TITLE_TYPES, null] },
      furnished: { type: ["boolean", "null"] },
      year_built: { type: ["integer", "null"] },
      description: { type: ["string", "null"] },
      source_lang: { type: ["string", "null"], enum: ["en", "km", "zh", "fr", null] },
      missing: {
        type: "array",
        items: { type: "string" },
        description: "Champs indispensables qui manquent et qu'il faut redemander "
          + "à l'agent : property_type, transaction_type, price_usd, area_name.",
      },
    },
    required: ["property_type", "transaction_type", "price_usd", "negotiable",
               "area_name", "building_name", "bedrooms", "bathrooms",
               "indoor_area_sqm", "land_area_sqm", "floor", "unit_number",
               "title_type", "furnished", "year_built", "description",
               "source_lang", "missing"],
    additionalProperties: false,
  },
};

const SYSTEM = `Tu extrais les champs d'annonces immobilières cambodgiennes envoyées par des agents sur Telegram.

Contexte de marché qui change la lecture d'un message :
- Les prix sont en dollars américains. « 185k » = 185000, « 1.2M » = 1200000.
- Un loyer se dit au mois. « 800/month », « 800 per month » → transaction_type "rent".
- Les types locaux comptent : borey (lotissement fermé) → borey_house, flat ou
  shophouse → flat_shophouse, condo → condo, land ou terrain → land.
- Les titres : hard title, soft title, strata title. « strata » n'est pas un
  synonyme de « hard ».
- Les quartiers arrivent sous toutes les graphies : BKK1, Boeung Keng Kang,
  Toul Kork, TK, ភ្នំពេញ, 西港. Recopie ce que l'agent a écrit, sans normaliser :
  c'est la table d'alias du portail qui fait la résolution.
- « nego » ou « negotiable » → negotiable true.

N'invente rien. Un champ non mentionné vaut null. Liste dans "missing" les
champs indispensables absents : property_type, transaction_type, price_usd,
area_name.`;

/**
 * @param {string} text            message de l'agent
 * @param {object} [options]
 * @param {Anthropic} [options.client]
 * @returns {Promise<object>} champs extraits, conformes au schéma
 */
export async function extractListing(text, options = {}) {
  const client = options.client ?? new Anthropic();

  const response = await client.messages.create({
    model: options.model ?? MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_listing" },
    messages: [{ role: "user", content: text }],
  });

  if (response.stop_reason === "refusal") {
    const detail = response.stop_details?.explanation ?? "sans explication";
    throw new Error(`extraction refusée : ${detail}`);
  }

  const call = response.content.find((b) => b.type === "tool_use");
  if (!call) throw new Error("le modèle n'a pas appelé record_listing");

  // L'entrée d'un tool_use est du JSON déjà désérialisé par le SDK ; on ne
  // fait jamais de correspondance de chaînes dessus.
  return { ...call.input, _usage: response.usage };
}

export const _internals = { EXTRACT_TOOL, SYSTEM };
