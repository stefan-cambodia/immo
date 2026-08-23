import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return { title: t("auth.signInTitle"), robots: { index: false, follow: false } };
}

const ERRORS = ["invalidCredentials", "rateLimited", "missingFields", "sessionExpired", "forbidden"];

export default async function LoginPage({
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
  const next = one("next") || `/${locale}/backoffice`;
  const error = ERRORS.includes(one("error")) ? one("error") : null;

  // Déjà connecté : rien à faire sur cette page.
  if (await getCurrentUser()) redirect(next.startsWith("/") ? next : `/${locale}/backoffice`);

  return (
    <div style={{
      minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center",
      padding: "2rem clamp(0.75rem, 3vw, 1.5rem)",
    }}>
      <div className="card" style={{ padding: "1.75rem", width: "100%", maxWidth: "24rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {t("auth.signInTitle")}
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)",
                    lineHeight: 1.6, marginTop: "0.375rem" }}>
          {t("auth.signInSubtitle")}
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

        <form action={signIn} style={{
          display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1.25rem",
        }}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="next" value={next} />

          <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
            {t("auth.email")}
            <input className="field" type="email" name="email" required autoComplete="username"
                   autoFocus inputMode="email" style={{ marginTop: "0.25rem" }} />
          </label>

          <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
            {t("auth.password")}
            <input className="field" type="password" name="password" required
                   autoComplete="current-password" style={{ marginTop: "0.25rem" }} />
          </label>

          <button type="submit" className="btn btn-primary" style={{ marginTop: "0.25rem" }}>
            {t("auth.signIn")}
          </button>
        </form>
      </div>
    </div>
  );
}
