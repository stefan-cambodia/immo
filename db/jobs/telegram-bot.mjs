#!/usr/bin/env node
/**
 * Worker du bot Telegram (§6.1, §7).
 *
 * Long polling plutôt que webhook : pas de domaine public ni de certificat à
 * gérer, et le worker peut tourner à côté de la base sans être exposé. Le
 * décalage de lecture est persisté, donc un redémarrage reprend là où il s'est
 * arrêté au lieu de rejouer l'historique.
 *
 *   TELEGRAM_BOT_TOKEN=… node db/jobs/telegram-bot.mjs
 *   node db/jobs/telegram-bot.mjs --once      # un seul cycle, pour vérifier
 */
import pg from "pg";
import { TelegramClient } from "../lib/telegram.mjs";
import { handleUpdate } from "../lib/bot.mjs";
import { extractListing } from "../lib/extract.mjs";
import { computePhash } from "../lib/phash.mjs";

const args = process.argv.slice(2);
const once = args.includes("--once");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN absent.");
  console.error("Créez un bot avec @BotFather, puis exportez le jeton.");
  process.exit(2);
}

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
});
await db.connect();

const tg = new TelegramClient(token);
const me = await tg.call("getMe");
console.log(`Bot @${me.username} connecté.`);

const deps = { db, tg, extract: extractListing, computePhash };

let running = true;
process.on("SIGINT", () => { running = false; console.log("\nArrêt demandé…"); });
process.on("SIGTERM", () => { running = false; });

async function cycle() {
  const { rows: [{ update_id: offset }] } = await db.query(
    `SELECT update_id FROM bot_offset WHERE id`);

  const updates = await tg.getUpdates(offset + 1);
  for (const update of updates) {
    try {
      // Chaque mise à jour est traitée dans sa propre transaction : une
      // conversation qui échoue n'entraîne pas les autres.
      await db.query("BEGIN");
      const result = await handleUpdate(deps, update);
      await db.query(
        `UPDATE bot_offset SET update_id = $1, updated_at = now() WHERE id`,
        [update.update_id]);
      await db.query("COMMIT");
      console.log(`  ${update.update_id} → ${result.action}`);
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      console.error(`  ${update.update_id} → échec : ${err.message}`);
      // Le décalage avance quand même : une mise à jour empoisonnée ne doit
      // pas bloquer indéfiniment la file.
      await db.query(`UPDATE bot_offset SET update_id = $1 WHERE id`, [update.update_id]);
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) {
        await tg.sendMessage(chatId, "Une erreur est survenue. Réessayez dans un instant.")
          .catch(() => {});
      }
    }
  }
  return updates.length;
}

if (once) {
  const n = await cycle();
  console.log(`${n} mise(s) à jour traitée(s).`);
} else {
  while (running) {
    try {
      await cycle();
    } catch (err) {
      console.error("Cycle en échec :", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

await db.end();
