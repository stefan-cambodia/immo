#!/usr/bin/env node
/**
 * Relance J-7 des annonces qui approchent de l'expiration (§6.3).
 *
 * « Bouton "toujours disponible ?" en un clic » : le message porte un bouton
 * inline dont le callback reconduit l'annonce de 45 jours sans que l'agent ait
 * à quitter Telegram. C'est la contrepartie de l'expiration automatique — sans
 * elle, la fraîcheur affichée se paierait en annonces perdues.
 *
 *   TELEGRAM_BOT_TOKEN=… node db/jobs/send-reminders.mjs [--dry-run] [--json]
 */
import pg from "pg";
import { TelegramClient, inlineKeyboard } from "../lib/telegram.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const asJson = args.includes("--json");
const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

// Une annonce n'est relancée qu'une fois par fenêtre : la contrainte est dans
// la requête, pas dans une variable du script.
const { rows: due } = await db.query(`
  SELECT l.id, l.price_usd, l.expires_at, p.reference,
         ag.name AS agent, ag.telegram_chat_id AS chat_id,
         loc.name_i18n->>'en' AS area
  FROM listings l
  JOIN properties p ON p.id = l.property_id
  JOIN agents ag ON ag.id = l.agent_id
  JOIN locations loc ON loc.id = p.location_id
  WHERE l.status = 'active'
    AND l.expires_at BETWEEN now() AND now() + interval '7 days'
    AND ag.telegram_chat_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM listing_reminders r
      WHERE r.listing_id = l.id AND r.sent_at > now() - interval '7 days')
  ORDER BY l.expires_at
  LIMIT 200`);

const summary = { due: due.length, sent: 0, failed: 0, dryRun };
log(`Annonces à relancer : ${due.length}`);

if (!dryRun && due.length) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("TELEGRAM_BOT_TOKEN absent."); process.exit(2); }
  const tg = new TelegramClient(token);

  for (const l of due) {
    const days = Math.max(0, Math.ceil((new Date(l.expires_at) - Date.now()) / 86400000));
    const text = `Votre annonce <b>${l.reference}</b> (${l.area}, $${Number(l.price_usd).toLocaleString("en-US")}) `
      + `expire dans ${days} jour${days > 1 ? "s" : ""}.\n\nToujours disponible ?`;
    try {
      await tg.sendMessage(l.chat_id, text,
        inlineKeyboard([["✅ Toujours disponible", `still:${l.id}`]]));
      await db.query(`INSERT INTO listing_reminders(listing_id) VALUES ($1)`, [l.id]);
      summary.sent++;
    } catch (err) {
      summary.failed++;
      log(`  ${l.reference} : ${err.message}`);
    }
  }
}

if (asJson) process.stdout.write(JSON.stringify(summary) + "\n");
else log(dryRun ? "--dry-run : aucun message envoyé." : `Envoyées : ${summary.sent} · échecs : ${summary.failed}`);

await db.end();
process.exit(summary.failed > 0 ? 1 : 0);
