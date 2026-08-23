#!/usr/bin/env node
/**
 * Envoi des alertes sur critères sauvegardés (phase 3).
 *
 * À chaque passage : pour chaque alerte confirmée et due, les biens apparus
 * depuis sa création et jamais signalés ; un message par alerte ; la trace
 * d'envoi dans `alert_deliveries`. Ce qui est « nouveau », ce qui est « dû »
 * et ce qui a « déjà été dit » sont trois requêtes dans la base, pas trois
 * variables ici : un redémarrage ne fait rien perdre ni rien répéter.
 *
 * Conçu pour tourner souvent (toutes les 15 minutes) : les alertes
 * instantanées en dépendent, et les quotidiennes portent leur propre cadence
 * via `last_notified_at`.
 *
 *   node db/jobs/send-alerts.mjs [--dry-run] [--json] [--limit N]
 *
 * Variables : DATABASE_URL, MAIL_PROVIDER/MAIL_API_KEY/MAIL_FROM (email),
 * TELEGRAM_BOT_TOKEN (Telegram), NEXT_PUBLIC_SITE_URL (liens).
 */
import pg from "pg";
import { createMailer } from "../lib/mail.mjs";
import { TelegramClient } from "../lib/telegram.mjs";
import { getTranslator } from "../lib/messages.mjs";
import { deliver, findDue } from "../lib/alerts.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const dryRun = flag("dry-run");
const asJson = flag("json");
const limit = Number(opt("limit", 500));

const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);
const emit = (payload) => { if (asJson) process.stdout.write(JSON.stringify(payload) + "\n"); };

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const result = { dryRun, due: 0, sent: 0, failed: 0, skipped: 0, properties: 0,
                 byChannel: { email: 0, telegram: 0 }, purged: 0 };

// Hygiène d'abord : les inscriptions jamais confirmées ne s'accumulent pas.
if (!dryRun) {
  const { rows: [{ purge_unconfirmed_alerts: purged }] } =
    await db.query(`SELECT purge_unconfirmed_alerts()`);
  result.purged = purged;
}

const due = await findDue(db, { limit });
result.due = due.length;
log(`Alertes à envoyer : ${due.length}`);

if (dryRun) {
  for (const d of due) {
    log(`  ${d.channel.padEnd(8)} ${d.frequency.padEnd(7)} ${String(d.propertyIds.length).padStart(3)} bien(s)  ${d.label}`);
  }
  log("--dry-run : aucun message envoyé.");
} else if (due.length) {
  // Les transports ne sont instanciés que s'ils servent : un serveur sans jeton
  // Telegram peut envoyer des emails, et réciproquement.
  const needsMail = due.some((d) => d.channel === "email");
  const needsTg = due.some((d) => d.channel === "telegram");
  let mailer = null, tg = null;
  if (needsMail) {
    try { mailer = createMailer(); } catch (err) { log(`Transport email indisponible : ${err.message}`); }
  }
  if (needsTg) {
    if (process.env.TELEGRAM_BOT_TOKEN) tg = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
    else log("TELEGRAM_BOT_TOKEN absent : les alertes Telegram sont laissées en attente.");
  }

  for (const d of due) {
    if ((d.channel === "email" && !mailer) || (d.channel === "telegram" && !tg)) {
      result.skipped++;
      continue;
    }
    const t = await getTranslator(d.locale);
    try {
      const outcome = await deliver(db, { tg, mailer, t, siteUrl }, d);
      if (outcome.skipped) { result.skipped++; continue; }
      result.sent++;
      result.properties += outcome.sent;
      result.byChannel[d.channel]++;
    } catch (err) {
      result.failed++;
      log(`  ${d.id} (${d.channel}) : ${err.message}`);
      // Un chat qui a bloqué le bot ne se débloquera pas tout seul : on coupe
      // l'alerte plutôt que d'échouer à chaque passage.
      if (d.channel === "telegram" && /blocked|chat not found|deactivated/i.test(err.message)) {
        await db.query(`UPDATE saved_searches SET unsubscribed_at = now() WHERE id = $1`, [d.id]);
        log(`  ${d.id} : chat injoignable, alerte arrêtée.`);
      }
    }
  }
  log(`Envoyées : ${result.sent} (${result.properties} biens) · échecs : ${result.failed} · reportées : ${result.skipped}`);
}

emit(result);
await db.end();
process.exit(result.failed > 0 ? 1 : 0);
