import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Inter, Kantumruy_Pro } from "next/font/google";
import { HTML_LANG, LOCALES, getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { SearchBox } from "@/components/SearchBox";
import "../globals.css";

// Sous-ensembles chargés séparément, font-display: swap (§7).
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const khmer = Kantumruy_Pro({
  subsets: ["khmer"],
  weight: ["400", "600", "700"],
  display: "swap",
  variable: "--font-kantumruy",
  preload: false, // Chargée uniquement là où le khmer est réellement rendu.
});

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);

  return {
    metadataBase: new URL(SITE),
    title: {
      default: `${t("common.siteName")} — ${t("common.tagline")}`,
      template: `%s — ${t("common.siteName")}`,
    },
    description: t("home.heroSubtitle"),
    alternates: {
      canonical: `/${locale}`,
      // hreflang complet + x-default : canal d'acquisition majeur (§4.1).
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [HTML_LANG[l], `/${l}`])),
        "x-default": "/en",
      },
    },
    openGraph: {
      type: "website",
      locale: HTML_LANG[locale],
      siteName: t("common.siteName"),
    },
  };
}

export default async function LocaleLayout({
  children, params,
}: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  return (
    <html lang={HTML_LANG[locale]} className={`${inter.variable} ${khmer.variable}`}>
      <body>
        <header style={{
          borderBottom: "1px solid var(--color-line)",
          background: "var(--color-surface)",
          position: "sticky", top: 0, zIndex: 30,
        }}>
          <div style={{
            maxWidth: "84rem", margin: "0 auto", padding: "0.625rem clamp(0.75rem, 3vw, 1.5rem)",
            display: "flex", alignItems: "center", gap: "clamp(0.5rem, 2vw, 1.5rem)", flexWrap: "wrap",
          }}>
            <Link href={`/${locale}`} style={{
              display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0,
            }}>
              <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden>
                <path d="M3 12.5 14 4l11 8.5V24a1 1 0 0 1-1 1h-7v-7h-6v7H4a1 1 0 0 1-1-1V12.5Z"
                      stroke="var(--color-brand)" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              <span style={{ fontWeight: 800, fontSize: "1.0625rem", letterSpacing: "-0.02em" }}>
                {t("common.siteName")}
              </span>
            </Link>

            <nav style={{
              display: "flex", gap: "0.25rem", alignItems: "center",
              fontSize: "0.875rem", flexWrap: "wrap",
            }}>
              <Link href={`/${locale}/search`} style={{ padding: "0.375rem 0.625rem", borderRadius: "0.375rem", fontWeight: 600 }}>
                {t("nav.buy")}
              </Link>
              <Link href={`/${locale}/search?txn=rent`} style={{ padding: "0.375rem 0.625rem", borderRadius: "0.375rem", fontWeight: 600 }}>
                {t("nav.rentNav")}
              </Link>
              <Link href={`/${locale}/search?foreign=1`} style={{
                padding: "0.375rem 0.625rem", borderRadius: "0.375rem", fontWeight: 600,
                color: "var(--color-brand)",
              }}>
                {t("nav.foreignEligible")}
              </Link>
            </nav>

            <div style={{ flex: "1 1 14rem", minWidth: "10rem", maxWidth: "28rem" }}>
              <SearchBox locale={locale} placeholder={t("home.searchPlaceholder")} />
            </div>

            <div style={{ marginInlineStart: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <Link href={`/${locale}/dashboard`} style={{
                fontSize: "0.8125rem", color: "var(--color-ink-faint)", whiteSpace: "nowrap",
              }}>
                {t("dashboard.title")}
              </Link>
              <Link href={`/${locale}/backoffice`} style={{
                fontSize: "0.8125rem", color: "var(--color-ink-faint)", whiteSpace: "nowrap",
              }}>
                {t("nav.backoffice")}
              </Link>
              {/* useSearchParams impose une frontière de suspense pour que le
                  reste de l'en-tête reste rendu statiquement. */}
              <Suspense fallback={<span style={{ width: "9rem" }} />}>
                <LocaleSwitcher current={locale} />
              </Suspense>
            </div>
          </div>
        </header>

        <main>{children}</main>

        <footer style={{
          borderTop: "1px solid var(--color-line)",
          background: "var(--color-surface-alt)",
          marginTop: "4rem", padding: "2rem clamp(0.75rem, 3vw, 1.5rem)",
        }}>
          <div style={{
            maxWidth: "84rem", margin: "0 auto", display: "flex",
            gap: "1.5rem", flexWrap: "wrap", alignItems: "start",
          }}>
            <div style={{ flex: "1 1 18rem" }}>
              <strong style={{ display: "block", marginBottom: "0.375rem" }}>{t("common.siteName")}</strong>
              <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", lineHeight: 1.6, maxWidth: "34rem" }}>
                {t("footer.disclaimer")}
              </p>
            </div>
            <nav style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.875rem" }}>
              <Link href={`/${locale}/search`}>{t("home.browseAll")}</Link>
              <Link href={`/${locale}/backoffice`}>{t("footer.forAgencies")}</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
