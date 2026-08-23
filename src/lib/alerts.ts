import "server-only";
import { headers } from "next/headers";
import { pool } from "./db";
import type { Translator } from "./i18n";
import type { Filters } from "./search";
// Socle des alertes en ESM simple, partagé avec le bot et le job d'envoi :
// l'application ne fait qu'y brancher ses pages.
import {
  AlertError, canonicalFilters, confirmByToken, countMatches, describeFilters,
  hasCriteria, subscribe, unsubscribeByToken,
} from "../../db/lib/alerts.mjs";
import { createMailer } from "../../db/lib/mail.mjs";

export { AlertError, canonicalFilters, hasCriteria };

export type AlertChannel = "email" | "telegram";
export type AlertFrequency = "instant" | "daily";

export interface CanonicalFilters extends Partial<Filters> { transaction: "sale" | "rent" }

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** Nom du bot pour les liens profonds `t.me/<bot>?start=…` ; absent = canal
 *  Telegram non proposé. */
export const botUsername = (): string | null =>
  process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null;

export async function summarizeCriteria(f: Partial<Filters>, t: Translator) {
  const filters = canonicalFilters(f) as CanonicalFilters;
  const [label, matches] = await Promise.all([
    describeFilters(pool, filters, t.locale, t) as Promise<string>,
    countMatches(pool, filters) as Promise<number>,
  ]);
  return { filters, label, matches, valid: hasCriteria(filters) as boolean };
}

export interface SubscribeResult {
  id: string; label: string; channel: AlertChannel; deepLink?: string;
}

export async function createAlert(input: {
  channel: string; email?: string; frequency?: string; filters: Partial<Filters>; t: Translator;
}): Promise<SubscribeResult> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
  // Le transport email n'est construit que pour ce canal : une configuration
  // mail absente ne doit pas empêcher une inscription Telegram.
  const mailer = input.channel === "email" ? createMailer(process.env) : null;
  return subscribe(pool, { mailer, t: input.t, siteUrl: SITE, botUsername: botUsername() }, {
    channel: input.channel, email: input.email, frequency: input.frequency,
    filters: input.filters, ip,
  });
}

export async function confirmAlert(token: string) {
  const row = await confirmByToken(pool, token);
  if (!row) return null;
  const matches = await countMatches(pool, row.filters);
  return { ...row, matches } as { id: string; label: string; locale: string; filters: CanonicalFilters; matches: number };
}

export async function unsubscribeAlert(token: string) {
  return unsubscribeByToken(pool, token) as Promise<{ id: string; label: string } | null>;
}
