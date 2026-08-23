/**
 * Transport Telegram (§7 : « Telegram Bot API + worker »).
 *
 * Deux implémentations derrière la même interface : l'API réelle, et un double
 * en mémoire. Le double n'est pas une commodité de test — c'est ce qui permet
 * de faire tourner la machine à états du bot, qui est la partie où les bugs se
 * cachent, sans jeton et sans réseau.
 */

const API = "https://api.telegram.org";

export class TelegramClient {
  constructor(token, { fetchImpl = fetch } = {}) {
    if (!token) throw new Error("jeton de bot manquant (TELEGRAM_BOT_TOKEN)");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, params = {}) {
    const res = await this.fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`Telegram ${method} a échoué : ${body.description ?? res.status}`);
    }
    return body.result;
  }

  /** Long polling. `timeout` est côté serveur Telegram : la requête reste
   *  ouverte jusqu'à ce qu'une mise à jour arrive, ce qui évite de marteler
   *  l'API. */
  getUpdates(offset, timeout = 25) {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] });
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  }

  answerCallbackQuery(id, text) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  /** Récupère le chemin d'un fichier envoyé par l'agent, puis son contenu. */
  async downloadFile(fileId) {
    const file = await this.call("getFile", { file_id: fileId });
    const res = await this.fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Double en mémoire. Les mises à jour sont injectées par le test, les envois
 * sont collectés pour être inspectés.
 */
export class FakeTelegram {
  constructor(updates = []) {
    this.pending = [...updates];
    this.sent = [];
    this.answered = [];
    this.files = new Map();
  }

  async getUpdates(offset) {
    const batch = this.pending.filter((u) => !offset || u.update_id >= offset);
    this.pending = [];
    return batch;
  }

  async sendMessage(chatId, text, extra = {}) {
    const message = { chat_id: chatId, text, ...extra };
    this.sent.push(message);
    return { message_id: this.sent.length, ...message };
  }

  async answerCallbackQuery(id, text) {
    this.answered.push({ id, text });
    return true;
  }

  async downloadFile(fileId) {
    return this.files.get(fileId) ?? Buffer.alloc(0);
  }

  /** Dernier message envoyé, pour les assertions. */
  last() { return this.sent[this.sent.length - 1]; }
  texts() { return this.sent.map((m) => m.text); }
}

/** Clavier proposant le partage de position — le pin, côté agent. */
export const askLocationKeyboard = (label) => ({
  reply_markup: {
    keyboard: [[{ text: label, request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
});

export const inlineKeyboard = (buttons) => ({
  reply_markup: { inline_keyboard: [buttons.map(([text, callback_data]) => ({ text, callback_data }))] },
});

export const removeKeyboard = { reply_markup: { remove_keyboard: true } };
