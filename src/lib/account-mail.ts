import "server-only";
import { getTranslator, type Locale } from "./i18n";
// Transport email abstrait (file | resend | postmark), le même que les
// alertes : changer de fournisseur reste deux variables d'environnement.
import { createMailer } from "../../db/lib/mail.mjs";

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export function setPasswordLink(locale: Locale, token: string): string {
  return `${SITE}/${locale}/account/set-password?token=${encodeURIComponent(token)}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Envoie l'email d'invitation ou de réinitialisation, dans la langue de la
 * personne. Le corps vient de `messages/*.json` (groupe `auth`), comme les
 * alertes : un seul fichier par langue, relu par le traducteur.
 *
 * L'échec d'envoi est signalé à l'appelant mais ne doit pas invalider le
 * jeton émis : le lien affiché en modération est le canal de secours — au
 * Cambodge, il partira souvent par Telegram de toute façon.
 */
export async function sendAccountEmail(
  kind: "invite" | "reset",
  locale: Locale,
  to: string,
  vars: { name: string; link: string }
): Promise<boolean> {
  const t = await getTranslator(locale);
  const subject = t(`auth.${kind}Subject`);
  const text = t(`auth.${kind}Body`, vars);
  const html = text
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line === vars.link
        ? `<p><a href="${vars.link}">${vars.link}</a></p>`
        : `<p>${escapeHtml(line)}</p>`
    )
    .join("\n");
  try {
    await createMailer().send({ to, subject, text, html, headers: undefined });
    return true;
  } catch (err) {
    console.error(`Envoi ${kind} vers ${to} échoué :`, err);
    return false;
  }
}
