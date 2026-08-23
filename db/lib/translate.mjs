import Anthropic from "@anthropic-ai/sdk";

/**
 * Traduction des descriptions d'annonces (§4.1).
 *
 * L'agent saisit dans une seule langue ; la fiche doit exister dans les
 * quatre. La traduction se fait à l'ingestion, une fois, pas à chaque
 * affichage — une fiche consultée mille fois ne doit pas coûter mille
 * traductions.
 *
 * Le volume à traduire est délibérément faible : le principe n°3 pousse tout
 * ce qui peut l'être dans des champs typés, déjà traduits par les tables de
 * référence. Ne reste que la phrase libre de l'agent.
 */

export const MODEL = "claude-opus-5";
export const LOCALES = ["fr", "en", "zh", "km"];

const LANG_NAMES = {
  fr: "français", en: "anglais", zh: "chinois simplifié", km: "khmer",
};

const TRANSLATE_TOOL = {
  name: "record_translations",
  description: "Enregistre la description d'annonce traduite dans les quatre langues du portail.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      fr: { type: "string", description: "Description en français." },
      en: { type: "string", description: "Description en anglais." },
      zh: { type: "string", description: "Description en chinois simplifié." },
      km: { type: "string", description: "Description en khmer." },
    },
    required: ["fr", "en", "zh", "km"],
    additionalProperties: false,
  },
};

const SYSTEM = `Tu traduis des descriptions d'annonces immobilières cambodgiennes pour un portail public, vers le français, l'anglais, le chinois simplifié et le khmer.

Ces textes engagent une agence auprès d'acheteurs. Traduis, n'embellis pas :

- Ne jamais ajouter un fait absent de l'original — pas de « spacieux », « lumineux » ou « idéalement situé » inventés.
- Ne jamais retirer un fait présent, y compris ce qui dessert le bien.
- Les chiffres, surfaces, étages, prix et devises sont recopiés à l'identique.
- Les termes de marché restent en l'état, ils sont compris tels quels au Cambodge : borey, hard title, soft title, strata title, flat, shophouse. Ne les traduis pas, ne les paraphrase pas.
- Les noms de quartiers et d'immeubles ne sont pas traduits ; utilise la forme locale usuelle quand elle existe (BKK1, Toul Kork, ភ្នំពេញ, 西港).
- Registre neutre et factuel, pas de langage promotionnel.
- Pour la langue source, recopie le texte d'origine tel quel plutôt que de le reformuler.

Le khmer ne sépare pas les mots par des espaces : écris-le naturellement, sans insérer d'espaces artificielles.`;

/**
 * @param {string} text        description dans sa langue source
 * @param {string} sourceLang  'fr' | 'en' | 'zh' | 'km'
 * @param {object} [options]   { client, model }
 * @returns {Promise<{fr:string,en:string,zh:string,km:string}>}
 */
export async function translateDescription(text, sourceLang, options = {}) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new Error("description vide");
  if (!LOCALES.includes(sourceLang)) throw new Error(`langue source inconnue : ${sourceLang}`);

  const client = options.client ?? new Anthropic();

  const response = await client.messages.create({
    model: options.model ?? MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    // La traduction n'est pas une tâche de raisonnement profond : l'effort
    // bas suffit et divise le coût sur un volume qui, lui, sera élevé.
    output_config: { effort: "low" },
    tools: [TRANSLATE_TOOL],
    tool_choice: { type: "tool", name: "record_translations" },
    messages: [{
      role: "user",
      content: `Langue source : ${LANG_NAMES[sourceLang]}.\n\n${trimmed}`,
    }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`traduction refusée : ${response.stop_details?.explanation ?? "sans explication"}`);
  }

  const call = response.content.find((b) => b.type === "tool_use");
  if (!call) throw new Error("le modèle n'a pas appelé record_translations");

  const out = call.input;
  const missing = LOCALES.filter((l) => !out[l] || !String(out[l]).trim());
  if (missing.length) throw new Error(`langues manquantes : ${missing.join(", ")}`);

  return { ...out, _usage: response.usage };
}

export const _internals = { TRANSLATE_TOOL, SYSTEM };

/**
 * Traite la file de traduction.
 *
 * Séparé du job pour que la logique — priorité aux premium, préservation du
 * texte source, marquage des échecs — soit vérifiable sans clé d'API : les
 * tests injectent `translate`.
 *
 * @param {import("pg").Client | import("pg").PoolClient} db
 * @param {object} [options] { translate, limit, retry, dryRun, onProgress }
 */
export async function translateQueue(db, options = {}) {
  const {
    translate = translateDescription,
    limit = 20,
    retry = false,
    dryRun = false,
    onProgress = () => {},
  } = options;

  // Les annonces sans description n'ont rien à traduire : elles sortent de la
  // file une bonne fois, au lieu d'être reprises à chaque passage.
  const { rowCount: skipped } = await db.query(`
    UPDATE listings SET translation_status = 'not_needed'
    WHERE translation_status = 'pending'
      AND coalesce(trim(description_i18n->>description_source_lang::text), '') = ''`);

  // Les agences premium passent devant : ce sont les seules dont la traduction
  // part ensuite en relecture humaine (§4.1), donc les seules où le délai
  // coûte deux fois.
  const { rows: queue } = await db.query(`
    SELECT l.id, p.reference, l.description_i18n AS description,
           l.description_source_lang::text AS source_lang,
           a.subscription_tier::text AS tier, a.name AS agency
    FROM listings l
    JOIN properties p ON p.id = l.property_id
    JOIN agencies a ON a.id = l.agency_id
    WHERE l.translation_status = ANY($1::translation_status[])
    ORDER BY (a.subscription_tier = 'premium') DESC, l.created_at
    LIMIT $2`,
    [retry ? ["pending", "failed"] : ["pending"], limit]);

  const summary = { queued: queue.length, translated: 0, failed: 0, skipped, dryRun,
                    tokens: 0, rows: [] };
  if (dryRun) { summary.rows = queue; return summary; }

  for (const row of queue) {
    const source = row.description?.[row.source_lang];
    try {
      // Séquentiel volontairement : le débit est limité par l'API, pas par
      // nous, et une file qui explose en parallèle se fait limiter.
      const out = await translate(source, row.source_lang);
      const merged = Object.fromEntries(LOCALES.map((l) => [l, out[l]]));
      // La langue source garde le texte de l'agent, mot pour mot.
      merged[row.source_lang] = source;

      await db.query(
        `UPDATE listings
         SET description_i18n = $2, translation_status = 'machine',
             translated_at = now(), translation_error = NULL
         WHERE id = $1`,
        [row.id, JSON.stringify(merged)]);
      summary.translated++;
      summary.tokens += (out._usage?.input_tokens ?? 0) + (out._usage?.output_tokens ?? 0);
      onProgress({ ok: true, reference: row.reference, sourceLang: row.source_lang });
    } catch (err) {
      await db.query(
        `UPDATE listings SET translation_status = 'failed', translation_error = $2 WHERE id = $1`,
        [row.id, String(err.message).slice(0, 500)]);
      summary.failed++;
      onProgress({ ok: false, reference: row.reference, error: err.message });
    }
  }
  return summary;
}
