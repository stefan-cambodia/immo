#!/usr/bin/env node
/**
 * Vérifie le circuit des alertes (phase 3) de bout en bout, sans réseau :
 * transport email en mémoire, Telegram doublé, base réelle.
 *
 * Le point critique est la parité : la fonction SQL qui décide quels biens
 * déclenchent une alerte doit retourner exactement ce que la page de
 * recherche affiche pour les mêmes critères. Sinon le visiteur reçoit des
 * biens qu'il ne retrouve pas sur le site, ou n'est pas prévenu de ceux qu'il
 * y verrait — les deux abîment la confiance dans l'alerte.
 *
 *   node db/checks/alerts.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import {
  canonicalFilters, confirmByToken, deliver, filtersToQuery, findDue, hasCriteria,
  subscribe, unsubscribeByToken, AlertError,
} from "../lib/alerts.mjs";
import { FakeMailer } from "../lib/mail.mjs";
import { FakeTelegram } from "../lib/telegram.mjs";
import { handleUpdate } from "../lib/bot.mjs";
import { getTranslator } from "../lib/messages.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");
const SITE = "https://example.test";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

const tag = "chk" + Math.random().toString(36).slice(2, 8);
const emailOf = (n) => `${tag}-${n}@example.test`;

// ---------------------------------------------------------------- parité
console.log("Parité entre la fonction SQL et la page de recherche");
let serverUp = true;
try { await fetch(`${BASE}/api/map?area=bkk1`); } catch { serverUp = false; }
if (!serverUp) {
  check(`serveur joignable sur ${BASE}`, false, "lancez `npm run dev -- -p 3111`");
} else {
  const { rows: [hood] } = await db.query(
    `SELECT l.slug FROM locations l JOIN properties p ON p.location_id = l.id
     GROUP BY l.slug ORDER BY count(*) DESC LIMIT 1`);
  const { rows: [city] } = await db.query(
    `SELECT slug FROM locations WHERE level = 'district' ORDER BY listing_count DESC LIMIT 1`);
  const { rows: [bld] } = await db.query(
    `SELECT b.slug FROM buildings b JOIN properties p ON p.building_id = b.id
     GROUP BY b.slug ORDER BY count(*) DESC LIMIT 1`);
  // Les annonces collectées ne sont pas rattachées à un immeuble : seul le
  // jeu engendré fournit les trois ancrages de la parité.
  check("le seed fournit quartier, district et immeuble peuplés",
        Boolean(hood && city && bld), "lancer npm run db:seed");
  const cases = !(hood && city && bld) ? [] : [
    { transaction: "sale", locationSlug: hood.slug },
    { transaction: "rent", locationSlug: city.slug, types: ["condo"], bedsMin: 2, priceMax: 2500 },
    { transaction: "sale", foreignEligible: true, amenities: ["pool", "gym"], priceMin: 80000, priceMax: 400000 },
    { transaction: "sale", buildingSlug: bld.slug },
    { transaction: "sale", types: ["villa", "borey_house"], bathsMin: 2, areaMin: 150, titles: ["hard"] },
    { transaction: "rent", furnished: true, floorMin: 5, types: ["condo"] },
    { transaction: "sale", bbox: [104.90, 11.54, 104.95, 11.58] },
    { transaction: "sale", polygon: [[104.90, 11.54], [104.95, 11.54], [104.95, 11.58], [104.90, 11.58]] },
  ];
  for (const f of cases) {
    const canon = canonicalFilters(f);
    const qs = filtersToQuery(canon);
    const points = await (await fetch(`${BASE}/api/map${qs}`)).json();
    const { rows: [{ n }] } = await db.query(
      `SELECT count(*)::int n FROM search_filter_matches($1::jsonb, NULL)`, [JSON.stringify(canon)]);
    check(`${qs.slice(1, 70)} → ${n} bien(s)`, points.length === n && n > 0,
          `SQL ${n} vs page ${points.length}`);
  }
}

// ------------------------------------------------------------- canonique
console.log("\nForme canonique des critères");
const c1 = canonicalFilters({ transaction: "rent", priceMin: "500", priceMax: "200", bedsMin: "2.7",
  types: ["condo", "condo", "DROP TABLE"], amenities: [], polygon: [[1, 2]], bbox: ["a", 1, 2, 3], q: "bkk1", sort: "price_asc", page: 3 });
check("prix min > max : le min est abandonné", c1.priceMin === undefined && c1.priceMax === 200, JSON.stringify(c1));
check("nombres entiers tronqués", c1.bedsMin === 2);
check("listes dédoublonnées et nettoyées", JSON.stringify(c1.types) === '["condo"]', JSON.stringify(c1.types));
check("géométries malformées rejetées", !c1.polygon && !c1.bbox);
check("texte libre, tri et pagination exclus", !("q" in c1) && !("sort" in c1) && !("page" in c1));
check("« tout à la location » n'est pas un critère", !hasCriteria({ transaction: "rent" }) && hasCriteria(c1));

// ------------------------------------------------------------ inscription
console.log("\nInscription email et confirmation");
const t = await getTranslator("fr");
const mailer = new FakeMailer();
const deps = { mailer, t, siteUrl: SITE, botUsername: "khmerestate_bot" };

// Un bien réel : l'alerte portera sur son quartier et son type, et une
// nouvelle annonce sur ce bien devra la déclencher.
const { rows: [target] } = await db.query(`
  SELECT p.id, p.reference, p.property_type::text AS type, loc.slug AS area, l.transaction_type::text AS txn
  FROM properties p JOIN locations loc ON loc.id = p.location_id
  JOIN listings l ON l.property_id = p.id AND l.status = 'active'
  WHERE (SELECT count(DISTINCT agency_id) FROM listings WHERE property_id = p.id AND status='active') = 1
  ORDER BY p.reference LIMIT 1`);
const filters = { transaction: target.txn, locationSlug: target.area, types: [target.type] };

const sub = await subscribe(db, deps, { channel: "email", email: emailOf("a"), frequency: "instant",
  filters, ip: "203.0.113.9" });
check("l'alerte est créée avec un libellé", sub.id && sub.label.length > 5, sub.label);
check("un mail de confirmation part", mailer.sent.length === 1 && mailer.last().to === emailOf("a"));
const confirmUrl = mailer.last().text.match(/https:\/\/example\.test\/fr\/alerts\/confirm\?token=([A-Za-z0-9_-]+)/);
check("le mail contient le lien de confirmation", Boolean(confirmUrl));
check("le mail porte un en-tête List-Unsubscribe", /alerts\/unsubscribe\?token=/.test(mailer.last().headers?.["List-Unsubscribe"] ?? ""));

const { rows: [beforeConfirm] } = await db.query(`SELECT confirmed_at, confirm_token_hash FROM saved_searches WHERE id = $1`, [sub.id]);
check("non confirmée tant que le lien n'est pas suivi", beforeConfirm.confirmed_at === null);
check("le jeton n'est pas stocké en clair", beforeConfirm.confirm_token_hash !== sub.confirmToken);
check("un jeton inconnu ne confirme rien", (await confirmByToken(db, "x".repeat(32))) === null);
const confirmed = await confirmByToken(db, confirmUrl[1]);
check("le lien confirme l'alerte", confirmed?.id === sub.id);
check("un second clic est sans effet mais accueilli", (await confirmByToken(db, confirmUrl[1]))?.id === sub.id);

// Rien ne doit partir : tous les biens correspondants existaient déjà.
let due = await findDue(db);
check("rien à envoyer juste après la création", !due.some((d) => d.id === sub.id),
      `${due.filter((d) => d.id === sub.id).length} alerte(s) due(s)`);

// --------------------------------------------------------- nouvelle annonce
console.log("\nNouvelle annonce correspondante");
const { rows: [other] } = await db.query(`
  SELECT ag.id AS agent_id, ag.agency_id FROM agents ag
  WHERE ag.agency_id NOT IN (SELECT agency_id FROM listings WHERE property_id = $1)
  LIMIT 1`, [target.id]);
const { rows: [newListing] } = await db.query(`
  INSERT INTO listings(property_id, agency_id, agent_id, transaction_type, price_usd, price_period, source)
  VALUES ($1, $2, $3, $4::transaction_type, 123456, $5::price_period, 'backoffice') RETURNING id`,
  [target.id, other.agency_id, other.agent_id, target.txn, target.txn === "rent" ? "monthly" : "total"]);

due = await findDue(db);
const mine = due.find((d) => d.id === sub.id);
check("l'alerte devient due", Boolean(mine));
check("elle porte exactement le bien nouvellement annoncé",
      mine && mine.propertyIds.length === 1 && mine.propertyIds[0] === target.id,
      JSON.stringify(mine?.propertyIds));

const outcome = await deliver(db, { mailer, t, siteUrl: SITE }, mine);
check("l'alerte est envoyée", outcome.sent === 1 && mailer.sent.length === 2);
const digest = mailer.last();
check("l'objet cite le libellé", digest.subject.includes(mine.label.slice(0, 20)), digest.subject);
check("le corps lie la fiche du bien", digest.html.includes(`/fr/property/${target.reference}`));
check("le corps lie la recherche complète", digest.html.includes(`/fr/search?`));
check("le corps lie le désabonnement", digest.text.includes(`/fr/alerts/unsubscribe?token=${mine.manageToken}`));
check("HTML échappé dans le message", !digest.html.includes("<script"));

const { rows: [after] } = await db.query(
  `SELECT last_notified_at, notified_count,
     (SELECT count(*)::int FROM alert_deliveries WHERE saved_search_id = $1) AS delivered
   FROM saved_searches WHERE id = $1`, [sub.id]);
check("l'envoi est tracé", after.notified_count === 1 && after.delivered === 1 && after.last_notified_at);

due = await findDue(db);
check("le même bien n'est jamais signalé deux fois", !due.some((d) => d.id === sub.id));

// Une baisse de prix ou une reconfirmation ne rend pas le bien « nouveau ».
await db.query(`UPDATE listings SET price_usd = 99999, last_confirmed_at = now() WHERE id = $1`, [newListing.id]);
due = await findDue(db);
check("une mise à jour d'annonce ne redéclenche pas", !due.some((d) => d.id === sub.id));

// ------------------------------------------------------------- quotidienne
console.log("\nFréquence quotidienne");
const daily = await subscribe(db, deps, { channel: "email", email: emailOf("b"), frequency: "daily", filters });
await confirmByToken(db, daily.confirmToken);
// On antidate la création pour que l'annonce insérée ci-dessus compte comme nouvelle.
await db.query(`UPDATE saved_searches SET created_at = now() - interval '2 days', last_notified_at = now() - interval '1 hour' WHERE id = $1`, [daily.id]);
due = await findDue(db);
check("une quotidienne notifiée il y a 1 h attend", !due.some((d) => d.id === daily.id));
await db.query(`UPDATE saved_searches SET last_notified_at = now() - interval '21 hours' WHERE id = $1`, [daily.id]);
due = await findDue(db);
check("elle redevient due après 20 h", due.some((d) => d.id === daily.id));

// --------------------------------------------------------------- telegram
console.log("\nCanal Telegram");
const sentBefore = mailer.sent.length;
const tgSub = await subscribe(db, deps, { channel: "telegram", frequency: "instant", filters });
check("l'inscription renvoie un lien profond", /^https:\/\/t\.me\/khmerestate_bot\?start=al_[A-Za-z0-9_-]+$/.test(tgSub.deepLink ?? ""), tgSub.deepLink);
check("pas de mail pour Telegram", mailer.sent.length === sentBefore);

const tg = new FakeTelegram();
const botDeps = { db, tg, extract: async () => { throw new Error("ne doit pas être appelé"); } };
const chatId = 900000000 + Math.floor(Math.random() * 1e6);
const startToken = tgSub.deepLink.split("start=")[1];
const r1 = await handleUpdate(botDeps, { update_id: 1, message: { chat: { id: chatId }, text: `/start ${startToken}` } });
check("/start <jeton> rattache le chat", r1.action === "alert_linked", r1.action);
check("la réponse est dans la langue de l'alerte", tg.last().text.startsWith("✅ Alerte activée"), tg.last().text);
const { rows: [linked] } = await db.query(`SELECT telegram_chat_id, confirmed_at FROM saved_searches WHERE id = $1`, [tgSub.id]);
check("le chat est enregistré et l'alerte confirmée", Number(linked.telegram_chat_id) === chatId && linked.confirmed_at);
const r2 = await handleUpdate(botDeps, { update_id: 2, message: { chat: { id: chatId + 1 }, text: `/start ${startToken}` } });
check("le même jeton ne peut pas être pris par un autre chat", r2.action === "alert_link_failed", r2.action);
check("un visiteur sans alerte n'est pas traité comme un agent",
      (await handleUpdate(botDeps, { update_id: 3, message: { chat: { id: chatId }, text: "/alerts" } })).action === "alerts_listed");
check("/alerts liste l'alerte", tg.last().text.includes(tgSub.label.slice(0, 15)), tg.last().text);

await db.query(`UPDATE saved_searches SET created_at = now() - interval '2 days' WHERE id = $1`, [tgSub.id]);
const tgDue = (await findDue(db)).find((d) => d.id === tgSub.id);
check("l'alerte Telegram est due", Boolean(tgDue));
await deliver(db, { tg, t: await getTranslator("fr"), siteUrl: SITE }, tgDue);
check("le message Telegram lie la fiche", String(tg.last().chat_id) === String(chatId)
      && tg.last().text.includes(`/fr/property/${target.reference}`), tg.last().text.slice(0, 80));

const r3 = await handleUpdate(botDeps, { update_id: 4, message: { chat: { id: chatId }, text: "/stop" } });
check("/stop coupe les alertes du chat", r3.action === "alerts_stopped" && r3.count === 1);
check("une alerte coupée n'est plus due", !(await findDue(db)).some((d) => d.id === tgSub.id));

// ------------------------------------------------------------ garde-fous
console.log("\nGarde-fous");
const expectError = async (input, code) => {
  try { await subscribe(db, deps, input); return false; }
  catch (err) { return err instanceof AlertError && err.code.startsWith(code) ? true : err.message; }
};
check("adresse invalide refusée", (await expectError({ channel: "email", email: "pas-une-adresse", filters }, "invalidEmail")) === true);
check("critères vides refusés", (await expectError({ channel: "email", email: emailOf("c"), filters: { transaction: "sale" } }, "missingCriteria")) === true);
check("canal inconnu refusé", (await expectError({ channel: "pigeon", filters }, "invalidChannel")) === true);
check("Telegram refusé sans nom de bot",
      (await (async () => { try { await subscribe(db, { ...deps, botUsername: null }, { channel: "telegram", filters }); return false; } catch (e) { return e.code; } })()) === "telegramUnavailable");
for (let i = 0; i < 5; i++) await subscribe(db, deps, { channel: "email", email: emailOf("d"), filters }).catch(() => {});
check("plafond de créations par adresse et par heure", (await expectError({ channel: "email", email: emailOf("d"), filters }, "tooMany")) === true);
mailer.failNext = new Error("SMTP down");
const failed = await expectError({ channel: "email", email: emailOf("e"), filters }, "mailFailed");
const { rows: [{ n: ghost }] } = await db.query(`SELECT count(*)::int n FROM saved_searches WHERE email = $1`, [emailOf("e")]);
check("un mail qui ne part pas ne laisse pas d'inscription fantôme", failed === true && ghost === 0);

check("le désabonnement par jeton fonctionne", (await unsubscribeByToken(db, sub.manageToken))?.id === sub.id);
check("un jeton de désabonnement inconnu est ignoré", (await unsubscribeByToken(db, "nope")) === null);

// ----------------------------------------------------------------- pages
if (serverUp) {
  console.log("\nPages");
  const fresh = await subscribe(db, deps, { channel: "email", email: emailOf("f"), filters });
  const page = await (await fetch(`${BASE}/en/alerts/confirm?token=${fresh.confirmToken}`)).text();
  check("la page de confirmation active l'alerte", page.includes("Your alert is active"));
  const bad = await (await fetch(`${BASE}/en/alerts/confirm?token=${"z".repeat(32)}`)).text();
  check("un jeton inconnu affiche une erreur", bad.includes("invalid"));
  const unsub = await (await fetch(`${BASE}/en/alerts/unsubscribe?token=${fresh.manageToken}`)).text();
  check("la page de désabonnement arrête l'alerte", unsub.includes("Alert stopped"));
  const form = await (await fetch(`${BASE}/fr/alerts?area=${target.area}&type=${target.type}`)).text();
  check("le formulaire affiche le libellé et le nombre de biens", form.includes("correspondent aujourd") && form.includes("Activer l"));
  const empty = await (await fetch(`${BASE}/fr/alerts`)).text();
  check("sans critère, pas de formulaire", empty.includes("au moins un crit") && !empty.includes('name="email"'));
  const results = await (await fetch(`${BASE}/en/search?area=${target.area}`)).text();
  check("la page de résultats propose l'alerte", results.includes(`/en/alerts?area=${target.area}`));
}

// --------------------------------------------------------------- nettoyage
await db.query(`DELETE FROM listings WHERE id = $1`, [newListing.id]);
await db.query(`DELETE FROM saved_searches WHERE email LIKE $1 OR telegram_chat_id = $2 OR id = $3`,
  [`${tag}-%`, chatId, tgSub.id]);
await db.end();
console.log(`\n  ${pass} vérifications passées, ${fail} échouées`);
process.exit(fail ? 1 : 0);
