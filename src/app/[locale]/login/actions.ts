"use server";

import { redirect } from "next/navigation";
import { attemptLogin, createSession, destroySession } from "@/lib/auth";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";

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

  await createSession(outcome.userId!);
  redirect(next);
}

export async function signOut(form: FormData) {
  const localeRaw = String(form.get("locale") ?? DEFAULT_LOCALE);
  const locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  await destroySession();
  redirect(`/${locale}/login`);
}
