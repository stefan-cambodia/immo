import { ingest } from "./ingest.mjs";
import { askLocationKeyboard, inlineKeyboard, removeKeyboard } from "./telegram.mjs";

/**
 * Machine à états de la conversation d'ingestion (§6.1).
 *
 *   idle ──texte/photos──► confirming ──✅──► awaiting_pin ──position──► publiée
 *                              │                                 │
 *                              └──✏️ corriger──► collecting ──────┘
 *
 * Le partage de position de Telegram est le pin manuel du principe n°2 : un
 * geste de l'agent, à l'endroit du bien. Aucune adresse n'est géocodée, et la
 * conversation ne peut pas aboutir sans ce geste — c'est l'étape bloquante,
 * exprimée dans le canal où travaillent réellement les agents.
 */

const T = {
  greet: "Bonjour ! Envoyez-moi une annonce : photos et description, ou juste le texte.\n\nExemple : <i>2BR condo BKK1, 14th floor, 72sqm, strata title, 185k nego</i>",
  unknownAgent: "Ce compte Telegram n'est rattaché à aucun agent. Contactez votre agence pour être enregistré.",
  extracting: "Je lis votre annonce…",
  missing: (fields) => `Il me manque : <b>${fields.join(", ")}</b>. Renvoyez-moi ces éléments.`,
  confirm: "Est-ce correct ?",
  askPin: "Parfait. Dernière étape : <b>partagez la position du bien</b>.\n\nAppuyez sur le bouton ci-dessous en étant sur place, ou envoyez une position choisie sur la carte. Sans position, l'annonce n'est pas publiée — nous ne devinons jamais l'emplacement à partir d'une adresse.",
  pinButton: "📍 Partager la position",
  cancelled: "Annulé. Envoyez une nouvelle annonce quand vous voulez.",
  needText: "Envoyez-moi aussi le texte de l'annonce : type de bien, quartier, prix.",
  areaUnknown: (name) =>
    `Je ne reconnais pas le quartier « ${name} ». Réécrivez-le autrement, ou donnez la ville.`,
  published: (ref, url) => `✅ Publié — <b>${ref}</b>\n${url}`,
  merged: (ref, url) =>
    `✅ Rattaché à un bien déjà connu — <b>${ref}</b>\nVotre annonce apparaît à côté de celles des autres agences.\n${url}`,
  review: (ref, url) =>
    `✅ Publié — <b>${ref}</b>\nUn bien très proche existe déjà : notre équipe vérifie s'il s'agit du même.\n${url}`,
  confirmed: "Merci, l'annonce est reconduite pour 45 jours.",
  alreadyGone: "Cette annonce n'est plus active.",
};

const REQUIRED = { property_type: "type de bien", transaction_type: "vente ou location",
                   price_usd: "prix", area_name: "quartier" };

const siteUrl = (ref) =>
  `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/en/property/${ref}`;

/** Résout le quartier via la table d'alias — le même chemin que la recherche. */
async function resolveArea(db, name) {
  const { rows } = await db.query(
    `WITH input AS (SELECT lower(unaccent($1)) AS q)
     SELECT l.id, l.slug,
            (SELECT max(GREATEST(similarity(lower(unaccent(term)), input.q),
                        CASE WHEN lower(unaccent(term)) = input.q THEN 1.0
                             WHEN lower(unaccent(term)) LIKE input.q || '%' THEN 0.92 ELSE 0 END))
             FROM unnest(l.aliases || ARRAY[l.slug]
                         || ARRAY(SELECT v FROM jsonb_each_text(l.name_i18n) AS e(k,v))) term,
                  input) AS score
     FROM locations l ORDER BY score DESC NULLS LAST LIMIT 1`, [name ?? ""]);
  return rows.length && Number(rows[0].score) >= 0.45 ? rows[0] : null;
}

async function loadSession(db, chatId) {
  const { rows } = await db.query(
    `INSERT INTO bot_sessions(chat_id) VALUES ($1)
     ON CONFLICT (chat_id) DO UPDATE SET chat_id = EXCLUDED.chat_id
     RETURNING chat_id, agent_id, state::text, draft`, [chatId]);
  return rows[0];
}

async function saveSession(db, chatId, state, draft) {
  await db.query(
    `UPDATE bot_sessions SET state = $2::bot_state, draft = $3 WHERE chat_id = $1`,
    [chatId, state, JSON.stringify(draft)]);
}

/** Rattache le chat à un agent enregistré. C'est l'agence qui déclare le
 *  compte Telegram de ses agents ; le bot n'accepte rien d'un inconnu. */
async function findAgent(db, chatId) {
  const { rows } = await db.query(
    `SELECT ag.id, ag.name, ag.agency_id, a.name AS agency
     FROM agents ag JOIN agencies a ON a.id = ag.agency_id
     WHERE ag.telegram_chat_id = $1`, [chatId]);
  return rows[0] ?? null;
}

function recap(fields) {
  const line = (label, value, suffix = "") =>
    value === null || value === undefined || value === "" ? null : `${label} : <b>${value}${suffix}</b>`;
  return [
    line("Type", fields.property_type),
    line("Transaction", fields.transaction_type === "rent" ? "location" : fields.transaction_type === "sale" ? "vente" : null),
    line("Prix", fields.price_usd ? `$${Number(fields.price_usd).toLocaleString("en-US")}` : null,
         fields.transaction_type === "rent" ? " / mois" : ""),
    line("Quartier", fields.area_name),
    line("Immeuble", fields.building_name),
    line("Chambres", fields.bedrooms),
    line("Salles de bain", fields.bathrooms),
    line("Surface", fields.indoor_area_sqm, " m²"),
    line("Terrain", fields.land_area_sqm, " m²"),
    line("Étage", fields.floor),
    line("Titre", fields.title_type),
    fields.furnished ? "Meublé : <b>oui</b>" : null,
  ].filter(Boolean).join("\n");
}

/**
 * Traite une mise à jour Telegram.
 *
 * @param {object} deps  { db, tg, extract }  — `extract` est injecté pour que
 *   la machine à états soit testable sans appel de modèle.
 */
export async function handleUpdate(deps, update) {
  const { db, tg } = deps;

  if (update.callback_query) return handleCallback(deps, update.callback_query);
  const msg = update.message;
  if (!msg) return { action: "ignored" };

  const chatId = msg.chat.id;
  const session = await loadSession(db, chatId);
  const agent = await findAgent(db, chatId);

  if (!agent) {
    await tg.sendMessage(chatId, T.unknownAgent);
    return { action: "unknown_agent" };
  }

  const text = (msg.text ?? msg.caption ?? "").trim();

  if (text === "/start" || text === "/cancel") {
    await saveSession(db, chatId, "idle", {});
    await tg.sendMessage(chatId, text === "/start" ? T.greet : T.cancelled, removeKeyboard);
    return { action: text === "/start" ? "greeted" : "cancelled" };
  }

  // ------------------------------------------------ position = pin manuel
  if (msg.location) {
    if (session.state !== "awaiting_pin") {
      await tg.sendMessage(chatId, T.needText);
      return { action: "pin_without_draft" };
    }
    return publish(deps, chatId, session, agent, {
      lng: msg.location.longitude, lat: msg.location.latitude,
    });
  }

  // ----------------------------------------------------------- photos
  const draft = session.draft ?? {};
  if (msg.photo?.length) {
    // Telegram envoie plusieurs tailles ; la dernière est la plus grande.
    const best = msg.photo[msg.photo.length - 1];
    draft.photos = [...(draft.photos ?? []), { fileId: best.file_id,
      width: best.width, height: best.height }];
  }

  const combined = [draft.text, text].filter(Boolean).join("\n").trim();
  if (!combined) {
    draft.text = draft.text ?? "";
    await saveSession(db, chatId, "collecting", draft);
    await tg.sendMessage(chatId, T.needText);
    return { action: "awaiting_text", photos: draft.photos?.length ?? 0 };
  }
  draft.text = combined;

  // ------------------------------------------------------- extraction
  await tg.sendMessage(chatId, T.extracting);
  let fields;
  try {
    fields = await deps.extract(combined);
  } catch (err) {
    await saveSession(db, chatId, "collecting", draft);
    await tg.sendMessage(chatId, `Je n'ai pas réussi à lire l'annonce : ${err.message}`);
    return { action: "extract_failed", error: err.message };
  }

  const missing = Object.entries(REQUIRED)
    .filter(([key]) => fields[key] === null || fields[key] === undefined || fields[key] === "")
    .map(([, label]) => label);

  draft.fields = fields;

  if (missing.length) {
    await saveSession(db, chatId, "collecting", draft);
    await tg.sendMessage(chatId, `${recap(fields)}\n\n${T.missing(missing)}`);
    return { action: "missing_fields", missing };
  }

  const area = await resolveArea(db, fields.area_name);
  if (!area) {
    await saveSession(db, chatId, "collecting", draft);
    await tg.sendMessage(chatId, T.areaUnknown(fields.area_name));
    return { action: "area_unknown", area: fields.area_name };
  }
  draft.locationId = area.id;

  await saveSession(db, chatId, "confirming", draft);
  await tg.sendMessage(chatId, `${recap(fields)}\n\n${T.confirm}`,
    inlineKeyboard([["✅ Oui", "draft:accept"], ["✏️ Corriger", "draft:edit"],
                    ["✖️ Annuler", "draft:cancel"]]));
  return { action: "awaiting_confirmation", fields };
}

async function handleCallback(deps, cb) {
  const { db, tg } = deps;
  const chatId = cb.message?.chat?.id;
  const [kind, value] = String(cb.data ?? "").split(":");

  // Relance J-7 : « toujours disponible ? » en un clic (§6.3).
  if (kind === "still") {
    const { rows } = await db.query(
      `UPDATE listings
       SET last_confirmed_at = now(), expires_at = now() + interval '45 days'
       WHERE id = $1 AND status = 'active' RETURNING id`, [value]);
    await tg.answerCallbackQuery(cb.id, rows.length ? T.confirmed : T.alreadyGone);
    if (chatId) await tg.sendMessage(chatId, rows.length ? T.confirmed : T.alreadyGone);
    return { action: rows.length ? "listing_confirmed" : "listing_gone", listingId: value };
  }

  if (kind !== "draft" || !chatId) return { action: "ignored" };

  const session = await loadSession(db, chatId);
  const agent = await findAgent(db, chatId);
  if (!agent) { await tg.answerCallbackQuery(cb.id, "compte inconnu"); return { action: "unknown_agent" }; }

  if (value === "cancel") {
    await saveSession(db, chatId, "idle", {});
    await tg.answerCallbackQuery(cb.id, "Annulé");
    await tg.sendMessage(chatId, T.cancelled, removeKeyboard);
    return { action: "cancelled" };
  }
  if (value === "edit") {
    await saveSession(db, chatId, "collecting", session.draft);
    await tg.answerCallbackQuery(cb.id, "Renvoyez le texte corrigé");
    await tg.sendMessage(chatId, "Renvoyez-moi l'annonce corrigée.");
    return { action: "editing" };
  }
  if (value === "accept") {
    await saveSession(db, chatId, "awaiting_pin", session.draft);
    await tg.answerCallbackQuery(cb.id, "Position ?");
    await tg.sendMessage(chatId, T.askPin, askLocationKeyboard(T.pinButton));
    return { action: "awaiting_pin" };
  }
  return { action: "ignored" };
}

/** Dépose la soumission dans l'entonnoir commun, une fois le pin obtenu. */
async function publish(deps, chatId, session, agent, pin) {
  const { db, tg } = deps;
  const draft = session.draft ?? {};
  const f = draft.fields ?? {};

  const photos = [];
  for (const [i, photo] of (draft.photos ?? []).entries()) {
    let phash = null;
    try {
      const bytes = await tg.downloadFile(photo.fileId);
      if (bytes?.length && deps.computePhash) phash = await deps.computePhash(bytes);
    } catch { /* une photo illisible ne doit pas faire échouer l'annonce */ }
    photos.push({ url: `telegram:${photo.fileId}`, phash,
                  width: photo.width, height: photo.height, position: i });
  }

  const outcome = await ingest(db, {
    source: "telegram_bot",
    agencyId: agent.agency_id,
    agentId: agent.id,
    externalRef: `tg:${chatId}:${Date.now()}`,
    payload: { text: draft.text, chatId },
    normalized: {
      propertyType: f.property_type,
      locationId: draft.locationId,
      buildingId: null,
      floor: f.floor ?? null,
      unitNumber: f.unit_number ?? null,
      bedrooms: f.bedrooms ?? 0,
      bathrooms: f.bathrooms ?? 0,
      indoorAreaSqm: f.indoor_area_sqm ?? null,
      landAreaSqm: f.land_area_sqm ?? null,
      titleType: f.title_type ?? "unknown",
      yearBuilt: f.year_built ?? null,
      furnished: f.furnished ?? false,
      transactionType: f.transaction_type === "rent" ? "rent" : "sale",
      priceUsd: f.price_usd,
      negotiable: f.negotiable ?? true,
      description: f.description ?? draft.text,
      descriptionLang: f.source_lang ?? "en",
      lng: pin.lng, lat: pin.lat,
    },
    photos,
  });

  await saveSession(db, chatId, "idle", {});

  if (outcome.status !== "accepted") {
    await tg.sendMessage(chatId, "L'annonce n'a pas pu être publiée. Réessayez ou contactez le support.");
    return { action: "publish_failed", outcome };
  }

  const url = siteUrl(outcome.reference);
  const message = outcome.decision === "merge" ? T.merged(outcome.reference, url)
                : outcome.decision === "review" ? T.review(outcome.reference, url)
                : T.published(outcome.reference, url);
  await tg.sendMessage(chatId, message, removeKeyboard);
  return { action: "published", decision: outcome.decision, reference: outcome.reference,
           propertyId: outcome.propertyId };
}

export const _text = T;
