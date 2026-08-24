import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { peekToken } from "../../../../../db/lib/accounts.mjs";
import { completeSetPassword } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return { title: t("auth.setPasswordTitle"), robots: { index: false, follow: false } };
}

const ERRORS = ["passwordTooShort", "passwordMismatch", "invalidToken"];

export default async function SetPasswordPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? "";
  const token = one("token");
  const error = ERRORS.includes(one("error")) ? one("error") : null;

  // Le jeton est seulement regardé ici, pas consommé : recharger la page ne
  // brûle rien. Un jeton périmé ou déjà servi mène au même message qu'un
  // jeton inconnu.
  const peek = token ? await peekToken(pool, token) : null;

  return (
    <div style={{
      minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center",
      padding: "2rem clamp(0.75rem, 3vw, 1.5rem)",
    }}>
      <div className="card" style={{ padding: "1.75rem", width: "100%", maxWidth: "24rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("auth.setPasswordTitle")}
        </h1>

        {!peek ? (
          <>
            <p role="alert" style={{
              marginTop: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.5rem",
              background: "var(--color-danger-soft)", color: "var(--color-danger)",
              fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5,
            }}>
              {t("auth.invalidToken")}
            </p>
            <p style={{ marginTop: "1rem", fontSize: "0.8125rem", lineHeight: 1.6,
                        color: "var(--color-ink-soft)" }}>
              {t("auth.invalidTokenHint")}{" "}
              <Link href={`/${locale}/account/forgot`}
                    style={{ color: "var(--color-brand)", fontWeight: 600 }}>
                {t("auth.forgotTitle")}
              </Link>
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)",
                        lineHeight: 1.6, marginTop: "0.375rem" }}>
              {t("auth.setPasswordSubtitle", { email: peek.email })}
            </p>

            {error && (
              <p role="alert" style={{
                marginTop: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.5rem",
                background: "var(--color-danger-soft)", color: "var(--color-danger)",
                fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5,
              }}>
                {t(`auth.${error}`)}
              </p>
            )}

            <form action={completeSetPassword} style={{
              display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1.25rem",
            }}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="token" value={token} />
              {/* Champ username masqué (pas type=hidden, que les gestionnaires
                  de mots de passe ignorent) : il associe le mot de passe
                  enregistré à la bonne adresse. */}
              <input type="text" name="username" defaultValue={peek.email} readOnly
                     autoComplete="username" aria-hidden="true" tabIndex={-1}
                     style={{ display: "none" }} />

              <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
                {t("auth.newPassword")}
                <input className="field" type="password" name="password" required
                       minLength={10} autoComplete="new-password" autoFocus
                       style={{ marginTop: "0.25rem" }} />
              </label>

              <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
                {t("auth.confirmPassword")}
                <input className="field" type="password" name="confirm" required
                       minLength={10} autoComplete="new-password"
                       style={{ marginTop: "0.25rem" }} />
              </label>

              <button type="submit" className="btn btn-primary" style={{ marginTop: "0.25rem" }}>
                {t("auth.setPasswordSubmit")}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
