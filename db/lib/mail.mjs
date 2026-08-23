/**
 * Transport email — couche d'abstraction, sur le modèle de la cartographie
 * (§7, §11) : changer de fournisseur revient à changer deux variables
 * d'environnement, aucun code applicatif ne dépend du fournisseur.
 *
 *   MAIL_PROVIDER   file | resend | postmark        (défaut : file)
 *   MAIL_API_KEY    jeton du fournisseur
 *   MAIL_FROM       « Khmer Estate <alerts@khmerestate.kh> »
 *   MAIL_OUTBOX     chemin du fichier en mode `file` (défaut : var/mail-outbox.jsonl)
 *
 * Le mode `file` n'envoie rien : chaque message est ajouté, en JSON, à un
 * fichier local. C'est le mode de développement — on relit le lien de
 * confirmation dans le fichier — et ce sur quoi `npm run check:alerts`
 * s'appuie pour parcourir le circuit de bout en bout sans réseau.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PROVIDERS = ["file", "resend", "postmark"];

export function createMailer(env = process.env, { fetchImpl = fetch } = {}) {
  const provider = env.MAIL_PROVIDER || "file";
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`MAIL_PROVIDER inconnu : ${provider} (attendu : ${PROVIDERS.join(" | ")})`);
  }
  const from = env.MAIL_FROM || "Khmer Estate <no-reply@localhost>";

  if (provider === "file") {
    return new FileMailer(resolve(env.MAIL_OUTBOX || "var/mail-outbox.jsonl"), from);
  }
  const key = env.MAIL_API_KEY;
  if (!key) throw new Error(`MAIL_API_KEY absent (MAIL_PROVIDER=${provider})`);
  return provider === "resend"
    ? new ResendMailer(key, from, fetchImpl)
    : new PostmarkMailer(key, from, fetchImpl);
}

/** Message : { to, subject, html, text, headers? }. Renvoie un identifiant. */
export class FileMailer {
  constructor(path, from) { this.path = path; this.from = from; this.provider = "file"; }

  async send(message) {
    await mkdir(dirname(this.path), { recursive: true });
    const id = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await appendFile(this.path,
      JSON.stringify({ id, at: new Date().toISOString(), from: this.from, ...message }) + "\n");
    return id;
  }
}

export class ResendMailer {
  constructor(key, from, fetchImpl) {
    this.key = key; this.from = from; this.fetch = fetchImpl; this.provider = "resend";
  }

  async send({ to, subject, html, text, headers }) {
    const res = await this.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject, html, text, headers }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status} : ${body.message ?? body.name ?? "échec"}`);
    return body.id;
  }
}

export class PostmarkMailer {
  constructor(key, from, fetchImpl) {
    this.key = key; this.from = from; this.fetch = fetchImpl; this.provider = "postmark";
  }

  async send({ to, subject, html, text, headers }) {
    const res = await this.fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.key, accept: "application/json",
                 "content-type": "application/json" },
      body: JSON.stringify({
        From: this.from, To: to, Subject: subject, HtmlBody: html, TextBody: text,
        MessageStream: "outbound",
        Headers: headers ? Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) : undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Postmark ${res.status} : ${body.Message ?? "échec"}`);
    return body.MessageID;
  }
}

/** Double en mémoire pour les vérifications : les envois sont collectés. */
export class FakeMailer {
  constructor() { this.sent = []; this.provider = "fake"; this.failNext = null; }
  async send(message) {
    if (this.failNext) { const err = this.failNext; this.failNext = null; throw err; }
    this.sent.push(message);
    return `fake-${this.sent.length}`;
  }
  last() { return this.sent[this.sent.length - 1]; }
}
