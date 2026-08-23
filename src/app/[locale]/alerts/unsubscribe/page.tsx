import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { unsubscribeAlert } from "@/lib/alerts";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return { title: t("alerts.title"), robots: { index: false, follow: false } };
}

/** Désabonnement en un clic depuis n'importe quel message. Idempotent. */
export default async function UnsubscribePage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);
  const sp = await searchParams;
  const token = (Array.isArray(sp.token) ? sp.token[0] : sp.token) ?? "";

  const alert = /^[A-Za-z0-9_-]{16,}$/.test(token) ? await unsubscribeAlert(token) : null;

  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "flex-start",
                  justifyContent: "center", padding: "2.5rem clamp(0.75rem, 3vw, 1.5rem)" }}>
      <div className="card" style={{ padding: "1.75rem", width: "100%", maxWidth: "34rem" }}>
        <h1 style={{ fontSize: "1.375rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
          {alert ? t("alerts.unsubscribed") : t("alerts.title")}
        </h1>
        {alert ? (
          <>
            <p style={{ fontWeight: 600, marginTop: "0.75rem" }}>{alert.label}</p>
            <p style={{ fontSize: "0.9375rem", color: "var(--color-ink-soft)", lineHeight: 1.6,
                        marginTop: "0.5rem" }}>
              {t("alerts.unsubscribedHint")}
            </p>
          </>
        ) : (
          <p role="alert" style={{ marginTop: "0.75rem", color: "var(--color-danger)", fontWeight: 600 }}>
            {t("alerts.invalidToken")}
          </p>
        )}
        <p style={{ marginTop: "1.25rem" }}>
          <Link href={`/${locale}/search`} className="btn btn-outline">{t("home.browseAll")}</Link>
        </p>
      </div>
    </div>
  );
}
