import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { requestPasswordReset } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return { title: t("auth.forgotTitle"), robots: { index: false, follow: false } };
}

export default async function ForgotPasswordPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);
  const sent = (await searchParams).sent === "1";

  return (
    <div style={{
      minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center",
      padding: "2rem clamp(0.75rem, 3vw, 1.5rem)",
    }}>
      <div className="card" style={{ padding: "1.75rem", width: "100%", maxWidth: "24rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("auth.forgotTitle")}
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)",
                    lineHeight: 1.6, marginTop: "0.375rem" }}>
          {t("auth.forgotSubtitle")}
        </p>

        {sent ? (
          // Même réponse quelle que soit l'adresse : cette page ne confirme
          // jamais qu'un compte existe.
          <p role="status" style={{
            marginTop: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.5rem",
            background: "var(--color-fresh-soft)", color: "var(--color-fresh)",
            fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5,
          }}>
            {t("auth.forgotSent")}
          </p>
        ) : (
          <form action={requestPasswordReset} style={{
            display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1.25rem",
          }}>
            <input type="hidden" name="locale" value={locale} />
            <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
              {t("auth.email")}
              <input className="field" type="email" name="email" required autoComplete="username"
                     autoFocus inputMode="email" style={{ marginTop: "0.25rem" }} />
            </label>
            <button type="submit" className="btn btn-primary" style={{ marginTop: "0.25rem" }}>
              {t("auth.forgotSubmit")}
            </button>
          </form>
        )}

        <p style={{ marginTop: "1rem", fontSize: "0.8125rem" }}>
          <Link href={`/${locale}/login`} style={{ color: "var(--color-brand)", fontWeight: 600 }}>
            {t("auth.backToSignIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
