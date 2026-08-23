import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { confirmAlert } from "@/lib/alerts";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import { filtersToQueryString } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return { title: t("alerts.title"), robots: { index: false, follow: false } };
}

/**
 * Double opt-in email : le clic sur le lien du mail active l'alerte. Un
 * second clic sur le même lien est sans effet mais reste accueilli — le
 * visiteur relit son mail, il ne doit pas tomber sur une erreur.
 */
export default async function ConfirmPage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);
  const sp = await searchParams;
  const token = (Array.isArray(sp.token) ? sp.token[0] : sp.token) ?? "";

  const alert = /^[A-Za-z0-9_-]{16,}$/.test(token) ? await confirmAlert(token) : null;

  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "flex-start",
                  justifyContent: "center", padding: "2.5rem clamp(0.75rem, 3vw, 1.5rem)" }}>
      <div className="card" style={{ padding: "1.75rem", width: "100%", maxWidth: "34rem" }}>
        {alert ? (
          <>
            <h1 style={{ fontSize: "1.375rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              {t("alerts.confirmed")}
            </h1>
            <p style={{ fontWeight: 600, marginTop: "0.75rem" }}>{alert.label}</p>
            <p style={{ fontSize: "0.9375rem", color: "var(--color-ink-soft)", lineHeight: 1.6,
                        marginTop: "0.5rem" }}>
              {t("alerts.confirmedHint", { n: formatNumber(alert.matches, locale) })}
            </p>
            <p style={{ marginTop: "1.25rem" }}>
              <Link href={`/${locale}/search${filtersToQueryString(alert.filters)}`}
                    className="btn btn-primary">
                {t("alerts.seeAll")}
              </Link>
            </p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: "1.375rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              {t("alerts.title")}
            </h1>
            <p role="alert" style={{ marginTop: "0.75rem", color: "var(--color-danger)", fontWeight: 600 }}>
              {t("alerts.invalidToken")}
            </p>
            <p style={{ marginTop: "1.25rem" }}>
              <Link href={`/${locale}/search`} className="btn btn-outline">{t("home.browseAll")}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
