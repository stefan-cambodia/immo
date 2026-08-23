import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { botUsername, summarizeCriteria } from "@/lib/alerts";
import { getTranslator, isLocale, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import { filtersToQueryString, parseFilters, suggest, type Filters } from "@/lib/search";
import { subscribeAction } from "./actions";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> }
): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslator(locale);
  return { title: t("alerts.title"), robots: { index: false, follow: true } };
}

const ERRORS = ["invalidEmail", "tooMany", "missingCriteria", "mailFailed", "telegramUnavailable",
  "invalidChannel", "mailUnavailable", "generic"];

/** Les critères, sous forme de champs cachés : la même grammaire que l'URL. */
function HiddenFilters({ f }: { f: Filters }) {
  const qs = new URLSearchParams(filtersToQueryString(f).replace(/^\?/, ""));
  qs.delete("q"); qs.delete("sort"); qs.delete("page"); qs.delete("fresh");
  return (
    <>
      {[...qs.entries()].map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

export default async function AlertsPage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<SP> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? "";
  const f = parseFilters(sp);

  // Saisie libre : résolue par la table d'alias, comme sur la page de
  // résultats. Une alerte est enregistrée sur un quartier, jamais sur un texte.
  if (f.q && !f.locationSlug && !f.buildingSlug) {
    const [best] = await suggest(f.q, 1);
    if (best && best.score >= 0.45) {
      if (best.kind === "location") f.locationSlug = best.slug;
      else f.buildingSlug = best.slug;
    }
  }

  const { label, matches, valid } = await summarizeCriteria(f, t);
  const done = one("done");
  const error = ERRORS.includes(one("error")) ? one("error") : null;
  const channel = one("channel") === "telegram" ? "telegram" : "email";
  const frequency = one("frequency") === "instant" ? "instant" : "daily";
  const telegram = botUsername();
  // Un code sans texte dédié (transport mail absent, canal inconnu…) tombe sur
  // le message générique plutôt que d'afficher la clé.
  const errorKey = error ? `alerts.error${error[0].toUpperCase()}${error.slice(1)}` : "";
  const errorMessage = error
    ? (t(errorKey) === errorKey ? t("alerts.errorGeneric") : t(errorKey)) : null;
  const searchHref = `/${locale}/search${filtersToQueryString(f)}`;

  const Box = ({ children }: { children: React.ReactNode }) => (
    <div style={{
      minHeight: "60vh", display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "2.5rem clamp(0.75rem, 3vw, 1.5rem)",
    }}>
      <div className="card" style={{ padding: "1.75rem", width: "100%", maxWidth: "34rem" }}>
        {children}
      </div>
    </div>
  );

  const Title = ({ children }: { children: React.ReactNode }) => (
    <h1 style={{ fontSize: "1.375rem", fontWeight: 800, letterSpacing: "-0.02em" }}>{children}</h1>
  );
  const Sub = ({ children }: { children: React.ReactNode }) => (
    <p style={{ fontSize: "0.9375rem", color: "var(--color-ink-soft)", lineHeight: 1.6,
                marginTop: "0.5rem" }}>{children}</p>
  );

  if (done === "email") {
    return (
      <Box>
        <Title>{t("alerts.emailSent")}</Title>
        <Sub>{t("alerts.emailSentHint", { email: one("email") })}</Sub>
        <p style={{ marginTop: "1.25rem" }}>
          <Link href={searchHref} className="btn btn-outline">{t("common.backToResults")}</Link>
        </p>
      </Box>
    );
  }
  if (done === "telegram") {
    const link = one("link");
    return (
      <Box>
        <Title>{t("alerts.telegramOpen")}</Title>
        <Sub>{t("alerts.telegramOpenHint")}</Sub>
        {link.startsWith("https://t.me/") && (
          <p style={{ marginTop: "1.25rem" }}>
            <a href={link} className="btn btn-primary" rel="noopener">{t("alerts.openTelegram")}</a>
          </p>
        )}
        <p style={{ marginTop: "1rem" }}>
          <Link href={searchHref} style={{ fontSize: "0.875rem" }}>{t("common.backToResults")}</Link>
        </p>
      </Box>
    );
  }

  return (
    <Box>
      <Title>{t("alerts.createTitle")}</Title>
      <Sub>{t("alerts.createSubtitle")}</Sub>

      <section style={{
        marginTop: "1.25rem", padding: "0.875rem 1rem", borderRadius: "0.5rem",
        background: "var(--color-surface-alt)", border: "1px solid var(--color-line-soft)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem",
                      alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase",
                         letterSpacing: "0.04em", color: "var(--color-ink-faint)" }}>
            {t("alerts.criteria")}
          </span>
          <Link href={searchHref} style={{ fontSize: "0.8125rem" }}>{t("alerts.editCriteria")}</Link>
        </div>
        <p style={{ fontWeight: 600, marginTop: "0.375rem", lineHeight: 1.5 }}>{label}</p>
        {valid && (
          <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", marginTop: "0.25rem" }}>
            {t("alerts.matchesToday", { n: formatNumber(matches, locale) })}
          </p>
        )}
      </section>

      {!valid ? (
        <p role="alert" style={{
          marginTop: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.5rem",
          background: "var(--color-danger-soft)", color: "var(--color-danger)",
          fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5,
        }}>
          {t("alerts.noCriteria")}
        </p>
      ) : (
        <form action={subscribeAction} style={{
          display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1.25rem",
        }}>
          <input type="hidden" name="locale" value={locale} />
          <HiddenFilters f={f} />
          {/* Champ piège : invisible pour un humain, rempli par les robots. */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden
                 style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px" }} />

          {error && (
            <p role="alert" style={{
              padding: "0.75rem 0.875rem", borderRadius: "0.5rem",
              background: "var(--color-danger-soft)", color: "var(--color-danger)",
              fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5,
            }}>
              {errorMessage}
            </p>
          )}

          <fieldset>
            <legend style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase",
                             letterSpacing: "0.04em", color: "var(--color-ink-faint)",
                             marginBottom: "0.5rem" }}>
              {t("alerts.channel")}
            </legend>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              {(["email", "telegram"] as const).map((c) => {
                const disabled = c === "telegram" && !telegram;
                return (
                  <label key={c} style={{
                    display: "flex", alignItems: "center", gap: "0.5rem",
                    padding: "0.625rem 0.75rem", borderRadius: "0.5rem", cursor: disabled ? "not-allowed" : "pointer",
                    border: "1px solid var(--color-line)", fontWeight: 600, fontSize: "0.9375rem",
                    opacity: disabled ? 0.5 : 1,
                  }}>
                    <input type="radio" name="channel" value={c} defaultChecked={channel === c && !disabled}
                           disabled={disabled} />
                    {t(c === "email" ? "alerts.channelEmail" : "alerts.channelTelegram")}
                  </label>
                );
              })}
            </div>
            {!telegram && (
              <p style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", marginTop: "0.375rem" }}>
                {t("alerts.telegramUnavailable")}
              </p>
            )}
          </fieldset>

          <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", fontWeight: 600 }}>
            {t("alerts.email")}
            <input className="field" type="email" name="email" autoComplete="email" inputMode="email"
                   defaultValue={one("email")} style={{ marginTop: "0.25rem" }} />
          </label>

          <fieldset>
            <legend style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase",
                             letterSpacing: "0.04em", color: "var(--color-ink-faint)",
                             marginBottom: "0.5rem" }}>
              {t("alerts.frequency")}
            </legend>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
              {(["instant", "daily"] as const).map((fq) => (
                <label key={fq} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start",
                                         fontSize: "0.9375rem", cursor: "pointer" }}>
                  <input type="radio" name="frequency" value={fq} defaultChecked={frequency === fq}
                         style={{ marginTop: "0.25rem" }} />
                  <span>
                    <strong>{t(`alerts.${fq}`)}</strong>
                    <span style={{ display: "block", fontSize: "0.8125rem", color: "var(--color-ink-soft)" }}>
                      {t(`alerts.${fq}Hint`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <button type="submit" className="btn btn-primary" style={{ justifyContent: "center" }}>
            {t("alerts.submit")}
          </button>
          <p style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", lineHeight: 1.5 }}>
            {t("alerts.consent")}
          </p>
        </form>
      )}
    </Box>
  );
}
