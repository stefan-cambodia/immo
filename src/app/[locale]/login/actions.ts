"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { attemptLogin, createSession, destroySession, isLoginBlocked,
         recordLoginAttempt } from "@/lib/auth";
import { pool } from "@/lib/db";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { completeSecondFactor, issueToken, pendingSecondFactor }
  from "../../../../db/lib/accounts.mjs";
import { verifyTotp } from "../../../../db/lib/totp.mjs";

/** Cookie de l'étape intermédiaire : mot de passe validé, code TOTP attendu. */
const SECOND_FACTOR_COOKIE = "bo_2fa";

/** N'accepte qu'un chemin interne : `next=https://ailleurs` doit être inerte. */
function safeNext(value: FormDataEntryValue | null, locale: string): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return `/${locale}/backoffice`;
  return raw;
}

export async function signIn(form: FormData) {
  const localeRaw = String(form.get("locale") ?? DEFAULT_LOCALE);
  const locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const next = safeNext(form.get("next"), locale);

  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const back = (error: string) =>
    `/${locale}/login?error=${error}&next=${encodeURIComponent(next)}`;

  if (!email || !password) redirect(back("missingFields"));

  const outcome = await attemptLogin(email, password);
  if (!outcome.ok) {
    redirect(back(outcome.reason === "rate_limited" ? "rateLimited" : "invalidCredentials"));
  }

  // Second facteur : pas de session — un jeton de 5 minutes porté par un
  // cookie httpOnly, et la page passe à l'étape du code.
  if (outcome.secondFactor) {
    const issued = await issueToken(pool, {
      userId: outcome.userId, purpose: "second_factor", createdBy: null,
    });
    if (!issued) redirect(back("invalidCredentials"));
    (await cookies()).set(SECOND_FACTOR_COOKIE, issued.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 300,
    });
    redirect(`/${locale}/login?step=totp&next=${encodeURIComponent(next)}`);
  }

  await createSession(outcome.userId!);
  redirect(next);
}

/** Deuxième étape : le code TOTP. Un code faux ne brûle pas l'étape mais
 *  compte comme une tentative — la même limitation que le mot de passe. */
export async function verifySecondFactor(form: FormData) {
  const localeRaw = String(form.get("locale") ?? DEFAULT_LOCALE);
  const locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const next = safeNext(form.get("next"), locale);
  const code = String(form.get("code") ?? "");

  const store = await cookies();
  const token = store.get(SECOND_FACTOR_COOKIE)?.value ?? "";
  const restart = (error: string) =>
    `/${locale}/login?error=${error}&next=${encodeURIComponent(next)}`;

  const pending = await pendingSecondFactor(pool, token);
  if (!pending) redirect(restart("twoFactorExpired"));

  if (await isLoginBlocked(pending.email)) redirect(restart("rateLimited"));

  const step = verifyTotp(pending.secret, code, { lastStep: Number(pending.lastStep) });
  if (step === null) {
    await recordLoginAttempt(pending.email, false);
    redirect(`/${locale}/login?step=totp&error=invalidCode&next=${encodeURIComponent(next)}`);
  }

  const done = await completeSecondFactor(pool, token, step);
  if (!done) redirect(restart("twoFactorExpired"));

  await recordLoginAttempt(pending.email, true);
  store.delete(SECOND_FACTOR_COOKIE);
  await createSession(pending.userId);
  redirect(next);
}

export async function signOut(form: FormData) {
  const localeRaw = String(form.get("locale") ?? DEFAULT_LOCALE);
  const locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  await destroySession();
  redirect(`/${locale}/login`);
}
