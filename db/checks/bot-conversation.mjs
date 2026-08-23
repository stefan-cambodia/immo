#!/usr/bin/env node
/**
 * Déroule la conversation d'ingestion de bout en bout, sans jeton Telegram ni
 * appel de modèle : transport doublé, extraction injectée. Ce qui est vérifié
 * ici est la partie où les bugs se cachent — l'enchaînement des états et le
 * caractère bloquant du pin.
 *
 * Tout se joue dans une transaction annulée en fin de course.
 */
import pg from "pg";
import { handleUpdate } from "../lib/bot.mjs";
import { FakeTelegram } from "../lib/telegram.mjs";

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();
await db.query("BEGIN");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  ok ? pass++ : fail++;
};

// Un agent existant, rattaché à un chat Telegram connu.
const CHAT = 987654321;
const { rows: [agent] } = await db.query(
  `UPDATE agents SET telegram_chat_id = $1
   WHERE id = (SELECT id FROM agents LIMIT 1)
   RETURNING id, name, agency_id`, [CHAT]);

// Extraction simulée : ce que le modèle renverrait pour ce message.
const stubFields = {
  property_type: "condo", transaction_type: "sale", price_usd: 185000,
  negotiable: true, area_name: "BKK1", building_name: null, bedrooms: 2,
  bathrooms: 2, indoor_area_sqm: 72, land_area_sqm: null, floor: 14,
  unit_number: null, title_type: "strata", furnished: false, year_built: null,
  description: "2BR condo BKK1 14th floor", source_lang: "en", missing: [],
};
let extractCalls = 0;
const extract = async () => { extractCalls++; return { ...stubFields }; };

const tg = new FakeTelegram();
const deps = { db, tg, extract };
const msg = (over) => ({ update_id: 1, message: { chat: { id: CHAT }, ...over } });

console.log("Conversation d'ingestion");

let r = await handleUpdate(deps, msg({ text: "/start" }));
check("/start accueille l'agent", r.action === "greeted", r.action);

r = await handleUpdate(deps, msg({ photo: [{ file_id: "small", width: 90, height: 60 },
                                            { file_id: "big", width: 1280, height: 960 }] }));
check("photo seule → le bot réclame le texte", r.action === "awaiting_text", r.action);
check("la plus grande taille est retenue", r.photos === 1, String(r.photos));

r = await handleUpdate(deps, msg({ text: "2BR condo BKK1 14th floor 72sqm strata 185k nego" }));
check("texte → extraction puis demande de confirmation",
      r.action === "awaiting_confirmation", r.action);
check("le récapitulatif cite le quartier",
      tg.last().text.includes("BKK1"), tg.last().text.slice(0, 60));
check("trois boutons proposés",
      tg.last().reply_markup?.inline_keyboard?.[0]?.length === 3);

// --- le pin est bloquant : rien ne se publie sans lui ---
const before = (await db.query(`SELECT count(*)::int n FROM properties`)).rows[0].n;
r = await handleUpdate(deps, { update_id: 2, callback_query: {
  id: "cb1", data: "draft:accept", message: { chat: { id: CHAT } } } });
check("confirmation → demande de position", r.action === "awaiting_pin", r.action);
check("le clavier propose le partage de position",
      tg.last().reply_markup?.keyboard?.[0]?.[0]?.request_location === true);
const after = (await db.query(`SELECT count(*)::int n FROM properties`)).rows[0].n;
check("aucun bien créé tant que la position manque", before === after, `${before} → ${after}`);

// --- la position publie ---
r = await handleUpdate(deps, msg({ location: { longitude: 104.9219, latitude: 11.5468 } }));
check("position → publication", r.action === "published", r.action || JSON.stringify(r));
check("un bien est bien créé",
      (await db.query(`SELECT count(*)::int n FROM properties`)).rows[0].n === before + 1);
check("le message final porte la référence",
      Boolean(r.reference) && tg.last().text.includes(r.reference), tg.last().text.slice(0, 70));

const { rows: [created] } = await db.query(
  `SELECT p.reference, ST_X(p.geo_point) lng, ST_Y(p.geo_point) lat, p.geo_pin_by,
          l.source::text, l.price_usd
   FROM properties p JOIN listings l ON l.property_id = p.id
   WHERE p.reference = $1`, [r.reference]);
check("le pin enregistré est celui partagé",
      Math.abs(created.lng - 104.9219) < 1e-6 && Math.abs(created.lat - 11.5468) < 1e-6,
      `${created.lng}, ${created.lat}`);
check("la source est le bot", created.source === "telegram_bot", created.source);
check("le prix extrait est repris", Number(created.price_usd) === 185000, created.price_usd);

// --- la session est repartie à zéro ---
const { rows: [session] } = await db.query(
  `SELECT state::text, draft FROM bot_sessions WHERE chat_id = $1`, [CHAT]);
check("la session revient à idle", session.state === "idle", session.state);

// --- champs manquants ---
const partial = { ...stubFields, price_usd: null, area_name: null };
const deps2 = { db, tg, extract: async () => ({ ...partial }) };
r = await handleUpdate(deps2, msg({ text: "condo somewhere" }));
check("champs manquants → le bot les réclame", r.action === "missing_fields", r.action);
check("il nomme prix et quartier",
      r.missing.includes("prix") && r.missing.includes("quartier"), JSON.stringify(r.missing));

// --- quartier non résolu ---
const deps3 = { db, tg, extract: async () => ({ ...stubFields, area_name: "Zzyzx Heights" }) };
r = await handleUpdate(deps3, msg({ text: "condo Zzyzx Heights 100k" }));
check("quartier inconnu → refus explicite", r.action === "area_unknown", r.action);

// --- position envoyée hors contexte ---
await db.query(`UPDATE bot_sessions SET state='idle', draft='{}' WHERE chat_id=$1`, [CHAT]);
r = await handleUpdate(deps, msg({ location: { longitude: 104.9, latitude: 11.5 } }));
check("position sans brouillon → ignorée", r.action === "pin_without_draft", r.action);

// --- chat inconnu ---
r = await handleUpdate(deps, { update_id: 9, message: { chat: { id: 111222333 }, text: "hello" } });
check("chat non rattaché → refusé", r.action === "unknown_agent", r.action);

// --- relance J-7 en un clic ---
const { rows: [listing] } = await db.query(
  `SELECT id, last_confirmed_at FROM listings WHERE status='active'
   AND last_confirmed_at < now() - interval '10 days' LIMIT 1`);
r = await handleUpdate(deps, { update_id: 10, callback_query: {
  id: "cb2", data: `still:${listing.id}`, message: { chat: { id: CHAT } } } });
check("« toujours disponible ? » reconduit l'annonce", r.action === "listing_confirmed", r.action);
const { rows: [renewed] } = await db.query(
  `SELECT last_confirmed_at, expires_at FROM listings WHERE id = $1`, [listing.id]);
check("la date de confirmation avance",
      new Date(renewed.last_confirmed_at) > new Date(listing.last_confirmed_at));
check("l'expiration repart à 45 jours",
      Math.round((new Date(renewed.expires_at) - Date.now()) / 86400000) === 45,
      String(Math.round((new Date(renewed.expires_at) - Date.now()) / 86400000)));

// Seul le message texte déclenche une extraction : ni /start, ni la photo
// seule, ni les rappels de callback ne consomment un appel de modèle.
check("un seul appel de modèle sur toute la conversation", extractCalls === 1, String(extractCalls));

await db.query("ROLLBACK");
await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
