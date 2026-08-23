/**
 * Alertes sur critères sauvegardés (phase 3).
 *
 * Module partagé, en ESM simple, comme `ingest.mjs` : l'application (page
 * d'inscription, confirmation, désabonnement), le bot Telegram (lien profond
 * `/start al_<jeton>`) et le job d'envoi passent tous par ici. La
 * correspondance critères → biens, elle, vit dans la base
 * (`search_filter_matches`, migration 012) : c'est la seule définition.
 *
 * Cycle de vie d'une alerte :
 *
 *   créée ──email : lien de confirmation──► confirmée ──job──► notifiée…
 *         └─telegram : /start al_<jeton>──┘                      │
 *                                               lien « stop » ◄──┘
 *
 * Aucun compte : une alerte, c'est une adresse (ou un chat) et des critères,
 * plus deux jetons : confirmation (empreinte) et désabonnement (en clair).
 */
import { createHash, randomBytes } from "node:crypto";
import { i18nField } from "./messages.mjs";

export const CHANNELS = ["email", "telegram"];
export const FREQUENCIES = ["instant", "daily"];

/** Plafonds anti-abus. Un visiteur de bonne foi n'en approche jamais. */
export const LIMITS = {
  perEmailActive: 10,   // alertes vivantes par adresse
  perEmailHour: 5,      // créations par adresse et par heure
  perIpHour: 20,        // créations par adresse IP et par heure
  perMessage: 20,       // biens détaillés par message ; au-delà, « et N de plus »
};

const LOCALE_TAG = { fr: "fr-FR", en: "en-US", zh: "zh-CN", km: "km-KH" };

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");

// ---------------------------------------------------------------------------
// Critères : forme canonique
// ---------------------------------------------------------------------------

/**
 * Réduit un objet de filtres (celui de `parseFilters`, ou un JSON reçu) à la
 * forme stockée : mêmes clés que `Filters` côté application, sans tri,
 * pagination, fraîcheur ni texte libre, et sans valeur vide. Les valeurs
 * inconnues d'une énumération ne sont pas rejetées ici — elles ne
 * correspondent simplement à rien — mais les nombres et les géométries sont
 * vérifiés, parce qu'une valeur malformée ferait échouer la requête.
 */
export function canonicalFilters(input = {}) {
  const out = { transaction: input.transaction === "rent" ? "rent" : "sale" };
  const str = (k) => {
    const v = input[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 120);
  };
  const num = (k, { int = false, min = 0 } = {}) => {
    const v = input[k];
    if (v === null || v === undefined || v === "") return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return;
    out[k] = int ? Math.trunc(n) : n;
  };
  const list = (k) => {
    const v = input[k];
    if (!Array.isArray(v)) return;
    const clean = [...new Set(v.filter((x) => typeof x === "string" && /^[a-z0-9_]{1,40}$/.test(x)))];
    if (clean.length) out[k] = clean.sort();
  };
  const bool = (k) => { if (input[k] === true || input[k] === "1" || input[k] === "true") out[k] = true; };

  str("locationSlug"); str("buildingSlug");
  list("types"); list("titles"); list("amenities");
  num("priceMin"); num("priceMax");
  num("bedsMin", { int: true }); num("bathsMin", { int: true });
  num("areaMin"); num("floorMin", { int: true, min: -5 });
  bool("foreignEligible"); bool("furnished");

  if (out.priceMin !== undefined && out.priceMax !== undefined && out.priceMin > out.priceMax) {
    delete out.priceMin;
  }
  const bbox = input.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => Number.isFinite(Number(n)))) {
    out.bbox = bbox.map(Number);
  }
  const poly = input.polygon;
  if (Array.isArray(poly) && poly.length >= 3 && poly.length <= 200
      && poly.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(Number(n))))) {
    out.polygon = poly.map((c) => c.map(Number));
  }
  return out;
}

/** Vrai si les critères restreignent quelque chose : « tout à la vente » n'est
 *  pas une alerte, c'est un abonnement au flux complet. */
export function hasCriteria(f) {
  return Object.keys(f).some((k) => k !== "transaction");
}

/** Chaîne de requête de la page de recherche, miroir de `filtersToQueryString`. */
export function filtersToQuery(f) {
  const p = new URLSearchParams();
  if (f.transaction === "rent") p.set("txn", "rent");
  if (f.locationSlug) p.set("area", f.locationSlug);
  if (f.buildingSlug) p.set("building", f.buildingSlug);
  for (const t of f.types ?? []) p.append("type", t);
  if (f.priceMin) p.set("pmin", String(f.priceMin));
  if (f.priceMax) p.set("pmax", String(f.priceMax));
  if (f.bedsMin) p.set("beds", String(f.bedsMin));
  if (f.bathsMin) p.set("baths", String(f.bathsMin));
  if (f.areaMin) p.set("area_min", String(f.areaMin));
  if (f.floorMin) p.set("floor", String(f.floorMin));
  for (const t of f.titles ?? []) p.append("title", t);
  if (f.foreignEligible) p.set("foreign", "1");
  if (f.furnished) p.set("furnished", "1");
  for (const a of f.amenities ?? []) p.append("amenity", a);
  if (f.bbox) p.set("bbox", f.bbox.join(","));
  if (f.polygon) p.set("polygon", f.polygon.map((c) => c.join(",")).join(";"));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function formatUsd(value, locale) {
  return new Intl.NumberFormat(LOCALE_TAG[locale] ?? "en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(Number(value));
}

/**
 * Résumé lisible des critères, dans la langue du visiteur. Figé à la création
 * et stocké : le label d'une alerte ne doit pas changer si un quartier est
 * renommé, sinon le visiteur ne reconnaît plus ce qu'il a demandé.
 */
export async function describeFilters(db, f, locale, t) {
  const parts = [];
  const names = await resolveNames(db, f);
  if (f.types?.length) parts.push(f.types.map((x) => t(`propertyType.${x}`)).join(" / "));
  else parts.push(t("alerts.labelAllTypes"));
  parts.push(t(f.transaction === "rent" ? "common.forRent" : "common.forSale").toLowerCase());
  if (names.building) parts.push(i18nField(names.building, locale));
  else if (names.location) parts.push(i18nField(names.location, locale));
  else if (f.polygon || f.bbox) parts.push(t("alerts.labelMapArea"));
  if (f.bedsMin) parts.push(t("alerts.labelBeds", { n: f.bedsMin }));
  if (f.priceMin && f.priceMax) {
    parts.push(`${formatUsd(f.priceMin, locale)} – ${formatUsd(f.priceMax, locale)}`);
  } else if (f.priceMax) parts.push(`≤ ${formatUsd(f.priceMax, locale)}`);
  else if (f.priceMin) parts.push(`≥ ${formatUsd(f.priceMin, locale)}`);
  if (f.areaMin) parts.push(t("alerts.labelArea", { n: f.areaMin }));
  if (f.floorMin) parts.push(t("alerts.labelFloor", { n: f.floorMin }));
  if (f.foreignEligible) parts.push(t("alerts.labelForeign"));
  if (f.furnished) parts.push(t("filters.furnished").toLowerCase());
  if (f.titles?.length) parts.push(f.titles.map((x) => t(`titleType.${x}`)).join(" / "));
  if (f.amenities?.length) parts.push(f.amenities.map((x) => t(`amenity.${x}`)).join(", "));
  return parts.join(" · ").slice(0, 200);
}

async function resolveNames(db, f) {
  const out = { location: null, building: null };
  if (f.locationSlug) {
    const { rows } = await db.query(`SELECT name_i18n FROM locations WHERE slug = $1`, [f.locationSlug]);
    out.location = rows[0]?.name_i18n ?? null;
  }
  if (f.buildingSlug) {
    const { rows } = await db.query(`SELECT name_i18n FROM buildings WHERE slug = $1`, [f.buildingSlug]);
    out.building = rows[0]?.name_i18n ?? null;
  }
  return out;
}

/** Nombre de biens correspondant aujourd'hui — l'argument affiché au moment
 *  de s'inscrire, et la preuve que les critères tiennent. */
export async function countMatches(db, f) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM search_filter_matches($1::jsonb, NULL)`, [JSON.stringify(f)]);
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Inscription
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class AlertError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * Crée l'alerte et lance sa confirmation.
 *
 * Email : envoie le lien de confirmation (double opt-in — on n'écrit jamais à
 * une adresse qui n'a pas cliqué). Telegram : renvoie le lien profond à
 * ouvrir ; c'est le `/start` dans le bot qui confirme et rattache le chat.
 *
 * @returns {{ id, label, channel, deepLink?: string, confirmToken, manageToken }}
 */
export async function subscribe(db, { mailer, t, siteUrl, botUsername }, input) {
  const channel = CHANNELS.includes(input.channel) ? input.channel : null;
  if (!channel) throw new AlertError("invalidChannel");
  if (channel === "telegram" && !botUsername) throw new AlertError("telegramUnavailable");

  const locale = t.locale;
  const frequency = FREQUENCIES.includes(input.frequency) ? input.frequency : "daily";
  const filters = canonicalFilters(input.filters ?? {});
  if (!hasCriteria(filters)) throw new AlertError("missingCriteria");

  let email = null;
  if (channel === "email") {
    email = String(input.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw new AlertError("invalidEmail");

    const { rows: [q] } = await db.query(
      `SELECT (SELECT count(*) FROM saved_searches WHERE lower(email) = $1
                AND unsubscribed_at IS NULL AND confirmed_at IS NOT NULL) AS active,
              (SELECT count(*) FROM saved_searches WHERE lower(email) = $1
                AND created_at > now() - interval '1 hour') AS recent`, [email]);
    if (Number(q.active) >= LIMITS.perEmailActive || Number(q.recent) >= LIMITS.perEmailHour) {
      throw new AlertError("tooMany");
    }
  }
  if (input.ip) {
    const { rows: [q] } = await db.query(
      `SELECT count(*) AS n FROM saved_searches
       WHERE created_ip = $1 AND created_at > now() - interval '1 hour'`, [input.ip]);
    if (Number(q.n) >= LIMITS.perIpHour) throw new AlertError("tooMany");
  }

  const label = await describeFilters(db, filters, locale, t);
  const confirmToken = newToken();
  const manageToken = newToken();

  const { rows: [row] } = await db.query(
    `INSERT INTO saved_searches(channel, email, locale, filters, label, frequency,
       confirm_token_hash, manage_token, created_ip)
     VALUES ($1::alert_channel, $2, $3::locale_code, $4, $5, $6::alert_frequency, $7, $8, $9)
     RETURNING id`,
    [channel, email, locale, JSON.stringify(filters), label, frequency,
     hashToken(confirmToken), manageToken, input.ip ?? null]);

  const result = { id: row.id, label, channel, confirmToken, manageToken, filters };

  if (channel === "email") {
    if (!mailer) throw new AlertError("mailUnavailable");
    const msg = renderConfirmationEmail({ t, label, siteUrl, locale, confirmToken, manageToken });
    try {
      await mailer.send({ to: email, ...msg });
    } catch (err) {
      // Une inscription dont le mail ne part pas n'existe pas : on ne laisse
      // pas une ligne « en attente » que personne ne pourra confirmer.
      await db.query(`DELETE FROM saved_searches WHERE id = $1`, [row.id]);
      throw new AlertError(`mailFailed:${err.message}`);
    }
  } else {
    result.deepLink = `https://t.me/${botUsername}?start=al_${confirmToken}`;
  }
  return result;
}

export async function confirmByToken(db, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE saved_searches SET confirmed_at = coalesce(confirmed_at, now())
     WHERE confirm_token_hash = $1 AND unsubscribed_at IS NULL AND channel = 'email'
     RETURNING id, label, locale::text AS locale, filters, channel::text AS channel,
               manage_token AS "manageToken"`, [hashToken(token)]);
  return rows[0] ?? null;
}

export async function unsubscribeByToken(db, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE saved_searches SET unsubscribed_at = coalesce(unsubscribed_at, now())
     WHERE manage_token = $1
     RETURNING id, label, locale::text AS locale, channel::text AS channel`, [token]);
  return rows[0] ?? null;
}

/** Telegram : `/start al_<jeton>` rattache le chat et vaut confirmation. */
export async function linkTelegram(db, chatId, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE saved_searches
     SET telegram_chat_id = $2, confirmed_at = coalesce(confirmed_at, now())
     WHERE confirm_token_hash = $1 AND unsubscribed_at IS NULL AND channel = 'telegram'
       AND (telegram_chat_id IS NULL OR telegram_chat_id = $2)
     RETURNING id, label, locale::text AS locale`, [hashToken(token), chatId]);
  return rows[0] ?? null;
}

/** Telegram : `/stop` coupe toutes les alertes du chat. */
export async function unsubscribeChat(db, chatId) {
  const { rows } = await db.query(
    `UPDATE saved_searches SET unsubscribed_at = now()
     WHERE telegram_chat_id = $1 AND unsubscribed_at IS NULL
     RETURNING id, locale::text AS locale`, [chatId]);
  return rows;
}

export async function listChatAlerts(db, chatId) {
  const { rows } = await db.query(
    `SELECT id, label, locale::text AS locale FROM saved_searches
     WHERE telegram_chat_id = $1 AND unsubscribed_at IS NULL AND confirmed_at IS NOT NULL
     ORDER BY created_at`, [chatId]);
  return rows;
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

/**
 * Alertes qui ont quelque chose à dire : confirmées, vivantes, dues selon leur
 * fréquence, et pour lesquelles au moins un bien correspondant est apparu
 * depuis la création sans avoir déjà été signalé.
 *
 * « Quotidienne » ne veut pas dire « à heure fixe » : l'alerte part au premier
 * passage du job au moins 20 h après la précédente. Le job tourne souvent (les
 * instantanées en dépendent) ; la cadence d'une quotidienne est portée par
 * `last_notified_at`, pas par le planning.
 */
export async function findDue(db, { limit = 500 } = {}) {
  const { rows } = await db.query(
    `SELECT s.id, s.channel::text AS channel, s.email,
            -- bigint → texte : node-pg ne le décode pas en nombre, et l'API
            -- Telegram accepte chat_id sous les deux formes.
            s.telegram_chat_id::text AS "chatId",
            s.locale::text AS locale, s.filters, s.label, s.frequency::text AS frequency,
            s.manage_token AS "manageToken",
            array_agg(m.property_id ORDER BY m.first_listed_at DESC) AS "propertyIds"
     FROM saved_searches s
     CROSS JOIN LATERAL search_filter_matches(s.filters, s.created_at) m
     WHERE s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL
       AND (s.channel = 'email' OR s.telegram_chat_id IS NOT NULL)
       AND (s.frequency = 'instant' OR s.last_notified_at IS NULL
            OR s.last_notified_at < now() - interval '20 hours')
       AND NOT EXISTS (SELECT 1 FROM alert_deliveries d
                       WHERE d.saved_search_id = s.id AND d.property_id = m.property_id)
     GROUP BY s.id
     ORDER BY s.last_notified_at NULLS FIRST
     LIMIT $1`, [limit]);
  return rows;
}

/** Fiches résumées des biens à annoncer, pour une alerte. */
export async function loadCards(db, propertyIds, transaction) {
  const { rows } = await db.query(
    `SELECT p.id, p.reference, p.property_type AS "propertyType", p.bedrooms, p.bathrooms,
            p.indoor_area_sqm AS "indoorArea", p.land_area_sqm AS "landArea",
            p.foreign_eligible AS "foreignEligible",
            loc.name_i18n AS "locationName", parent.name_i18n AS "parentName",
            b.name_i18n AS "buildingName",
            agg.price_min AS "priceMin", agg.agency_count AS "agencyCount",
            (SELECT url FROM media WHERE property_id = p.id ORDER BY position LIMIT 1) AS photo
     FROM properties p
     JOIN (SELECT property_id, min(price_usd) AS price_min,
                  count(DISTINCT agency_id)::int AS agency_count
           FROM listings WHERE status = 'active' AND transaction_type = $2::transaction_type
           GROUP BY property_id) agg ON agg.property_id = p.id
     JOIN locations loc ON loc.id = p.location_id
     LEFT JOIN locations parent ON parent.id = loc.parent_id
     LEFT JOIN buildings b ON b.id = p.building_id
     WHERE p.id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], p.id)`, [propertyIds, transaction]);
  return rows;
}

/**
 * Envoie une alerte et l'enregistre. La trace d'envoi et l'envoi lui-même ne
 * sont pas atomiques — on ne tient pas une transaction ouverte pendant un
 * appel réseau — mais l'ordre est choisi : d'abord envoyer, puis enregistrer.
 * Un échec après envoi coûte au pire un doublon au prochain passage ; un
 * échec avant n'a rien consommé.
 */
export async function deliver(db, { tg, mailer, t, siteUrl }, due) {
  const cards = await loadCards(db, due.propertyIds, due.filters.transaction);
  if (!cards.length) return { skipped: true };

  const msg = renderDigest({ t, due, cards, siteUrl });

  if (due.channel === "email") {
    if (!mailer) throw new Error("transport email indisponible");
    await mailer.send({ to: due.email, subject: msg.subject, html: msg.html, text: msg.text,
      headers: { "List-Unsubscribe": `<${msg.unsubscribeUrl}>` } });
  } else {
    if (!tg) throw new Error("client Telegram indisponible");
    await tg.sendMessage(due.chatId, msg.telegram, { disable_web_page_preview: cards.length > 1 });
  }

  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO alert_deliveries(saved_search_id, property_id)
       SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [due.id, due.propertyIds]);
    await db.query(
      `UPDATE saved_searches SET last_notified_at = now(), notified_count = notified_count + 1
       WHERE id = $1`, [due.id]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
  return { sent: cards.length };
}

// ---------------------------------------------------------------------------
// Rendu des messages
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function cardLine(c, locale, t, transaction) {
  const area = c.indoorArea ?? c.landArea;
  const bits = [t(`propertyType.${c.propertyType}`)];
  if (c.bedrooms) bits.push(t("alerts.cardBeds", { n: c.bedrooms }));
  if (area) bits.push(`${Math.round(Number(area))} ${t("common.sqm")}`);
  const where = [i18nField(c.buildingName, locale) || i18nField(c.locationName, locale),
                 i18nField(c.parentName, locale)].filter(Boolean).join(", ");
  const price = formatUsd(c.priceMin, locale) + (transaction === "rent" ? ` ${t("common.perMonth")}` : "");
  return { title: bits.join(" · "), where, price,
           extra: c.agencyCount > 1 ? t("alerts.agenciesCount", { n: c.agencyCount }) : "" };
}

export function renderDigest({ t, due, cards, siteUrl }) {
  const locale = t.locale;
  const shown = cards.slice(0, LIMITS.perMessage);
  const more = cards.length - shown.length;
  const searchUrl = `${siteUrl}/${locale}/search${filtersToQuery(due.filters)}`;
  const unsubscribeUrl = due.manageToken
    ? `${siteUrl}/${locale}/alerts/unsubscribe?token=${due.manageToken}` : null;
  const subject = t("alerts.digestSubject", { n: cards.length, label: due.label });
  const intro = t("alerts.digestIntro", { label: due.label });

  const items = shown.map((c) => ({ ...cardLine(c, locale, t, due.filters.transaction),
    url: `${siteUrl}/${locale}/property/${c.reference}`, ref: c.reference, photo: c.photo }));

  const text = [
    intro, "",
    ...items.map((i) => `• ${i.title} — ${i.where} — ${i.price}${i.extra ? ` (${i.extra})` : ""}\n  ${i.url}`),
    more > 0 ? `\n${t("alerts.andMore", { n: more })}` : "",
    "", `${t("alerts.seeAll")} : ${searchUrl}`,
    unsubscribeUrl ? `\n${t("alerts.stopAlert")} : ${unsubscribeUrl}` : "",
  ].join("\n");

  const html = `<!doctype html><html lang="${locale}"><body style="font-family:Inter,Arial,sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px 16px">
<h1 style="font-size:18px;margin:0 0 8px">${esc(subject)}</h1>
<p style="color:#555;margin:0 0 20px">${esc(intro)}</p>
${items.map((i) => `<table role="presentation" style="width:100%;border:1px solid #e5e5e5;border-radius:8px;margin-bottom:12px;border-collapse:separate"><tr>
${i.photo ? `<td style="width:112px;padding:8px"><a href="${esc(i.url)}"><img src="${esc(i.photo.startsWith("http") ? i.photo : siteUrl + i.photo)}" width="96" height="72" alt="" style="display:block;border-radius:6px;object-fit:cover"></a></td>` : ""}
<td style="padding:10px 12px;vertical-align:top"><a href="${esc(i.url)}" style="font-weight:700;color:#0b63ce;text-decoration:none">${esc(i.title)}</a><br>
<span style="color:#555;font-size:14px">${esc(i.where)}</span><br>
<strong>${esc(i.price)}</strong>${i.extra ? ` <span style="color:#777;font-size:13px">· ${esc(i.extra)}</span>` : ""}</td></tr></table>`).join("\n")}
${more > 0 ? `<p style="color:#555">${esc(t("alerts.andMore", { n: more }))}</p>` : ""}
<p style="margin:20px 0"><a href="${esc(searchUrl)}" style="background:#0b63ce;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${esc(t("alerts.seeAll"))}</a></p>
${unsubscribeUrl ? `<p style="color:#999;font-size:12px;margin-top:28px"><a href="${esc(unsubscribeUrl)}" style="color:#999">${esc(t("alerts.stopAlert"))}</a></p>` : ""}
</body></html>`;

  const telegram = [
    `<b>${esc(subject)}</b>`, "",
    ...items.map((i) => `• <a href="${esc(i.url)}">${esc(i.title)}</a> — ${esc(i.where)} — <b>${esc(i.price)}</b>${i.extra ? ` (${esc(i.extra)})` : ""}`),
    more > 0 ? `\n${esc(t("alerts.andMore", { n: more }))}` : "",
    "", `<a href="${esc(searchUrl)}">${esc(t("alerts.seeAll"))}</a>`,
    `<i>${esc(t("alerts.telegramStopHint"))}</i>`,
  ].join("\n");

  return { subject, text, html, telegram, searchUrl, unsubscribeUrl };
}

export function renderConfirmationEmail({ t, label, siteUrl, locale, confirmToken, manageToken }) {
  const confirmUrl = `${siteUrl}/${locale}/alerts/confirm?token=${confirmToken}`;
  const unsubscribeUrl = `${siteUrl}/${locale}/alerts/unsubscribe?token=${manageToken}`;
  const subject = t("alerts.confirmSubject", { label });
  const body = t("alerts.confirmBody", { label, site: t("common.siteName") });
  const text = `${body}\n\n${confirmUrl}\n\n${t("alerts.confirmIgnore")}`;
  const html = `<!doctype html><html lang="${locale}"><body style="font-family:Inter,Arial,sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px 16px">
<h1 style="font-size:18px;margin:0 0 12px">${esc(t("alerts.title"))}</h1>
<p style="line-height:1.6">${esc(body)}</p>
<p style="margin:20px 0"><a href="${esc(confirmUrl)}" style="background:#0b63ce;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${esc(t("alerts.confirmButton"))}</a></p>
<p style="color:#777;font-size:13px">${esc(confirmUrl)}</p>
<p style="color:#999;font-size:12px;margin-top:28px">${esc(t("alerts.confirmIgnore"))}</p>
</body></html>`;
  return { subject, text, html, headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` } };
}
