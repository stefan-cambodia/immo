"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { withTransaction } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { recordAuditStandalone } from "@/lib/audit";
import { sendAccountEmail, setPasswordLink } from "@/lib/account-mail";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";
import { consumeTokenAndSetPassword, requestReset, resetRateLimited }
  from "../../../../db/lib/accounts.mjs";
import { pool } from "@/lib/db";

const MIN_PASSWORD_LENGTH = 10;

function localeOf(form: FormData): Locale {
  const raw = String(form.get("locale") ?? DEFAULT_LOCALE);
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/**
 * Demande de réinitialisation. La réponse est LA MÊME que l'adresse soit
 * connue, inconnue, ou la demande au-delà des seuils : la page ne doit pas
 * servir d'oracle d'énumération des comptes. La différence vit dans
 * `password_reset_requests`, pas dans ce que voit le visiteur.
 */
export async function requestPasswordReset(form: FormData) {
  const locale = localeOf(form);
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 200);
  const done = `/${locale}/account/forgot?sent=1`;
  if (!email || !email.includes("@")) redirect(done);

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() ?? null;

  if (!(await resetRateLimited(pool, { email, ip }))) {
    const issued = await requestReset(pool, { email, ip });
    if (issued) {
      await sendAccountEmail("reset", locale, issued.email, {
        name: issued.name,
        link: setPasswordLink(locale, issued.token),
      });
    }
  }

  redirect(done);
}

/** Pose le mot de passe depuis un lien d'invitation ou de réinitialisation. */
export async function completeSetPassword(form: FormData) {
  const locale = localeOf(form);
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  const back = (error: string) =>
    `/${locale}/account/set-password?token=${encodeURIComponent(token)}&error=${error}`;

  if (password.length < MIN_PASSWORD_LENGTH) redirect(back("passwordTooShort"));
  if (password !== confirm) redirect(back("passwordMismatch"));

  const passwordHash = await hashPassword(password);
  // Consommation du jeton, pose du mot de passe et coupure des sessions
  // dans une même transaction : un lien ne peut pas être « à moitié servi ».
  const consumed = await withTransaction((client) =>
    consumeTokenAndSetPassword(client, { token, passwordHash }));
  if (!consumed) redirect(`/${locale}/account/set-password?error=invalidToken`);

  await recordAuditStandalone(
    { id: consumed.userId, email: consumed.email, role: consumed.role,
      agencyName: consumed.agencyName },
    {
      action: "password_set",
      targetType: "user",
      targetId: consumed.userId,
      targetLabel: consumed.email,
      details: { via: consumed.purpose },
    }
  );

  redirect(`/${locale}/login?notice=passwordSet`);
}
