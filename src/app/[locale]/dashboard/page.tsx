import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { daysSince, daysUntil, formatNumber, formatUsd } from "@/lib/format";
import { getTranslator, i18nField, isLocale, type Locale } from "@/lib/i18n";
import {
  agencyTotals, benchmark, dailySeries, leadBreakdown, listingPerformance,
  needsAttention, trafficSources,
} from "@/lib/dashboard";
import { Sparkline } from "@/components/Sparkline";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

const rate = (leads: number, views: number) =>
  views > 0 ? `${((leads / views) * 100).toFixed(1)} %` : "—";

export default async function DashboardPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);

  const user = await getCurrentUser();
  if (!user) redirect(`/${locale}/login`);

  // Une agence voit la sienne. La modération peut regarder n'importe laquelle,
  // ce qui sert à instruire une réclamation — « je ne reçois aucun contact ».
  const sp = await searchParams;
  const wanted = (Array.isArray(sp.agency) ? sp.agency[0] : sp.agency) ?? null;
  const agency = user.role === "admin"
    ? await queryOne<{ id: string; name: string; slug: string }>(
        wanted ? `SELECT id, name, slug FROM agencies WHERE slug = $1`
               : `SELECT id, name, slug FROM agencies ORDER BY name LIMIT 1`,
        wanted ? [wanted] : [])
    : await queryOne<{ id: string; name: string; slug: string }>(
        `SELECT id, name, slug FROM agencies WHERE id = $1`, [user.agencyId]);
  if (!agency) notFound();

  const [totals, series, sources, channels, perf, attention, bench, agencies] = await Promise.all([
    agencyTotals(agency.id),
    dailySeries(agency.id),
    trafficSources(agency.id),
    leadBreakdown(agency.id),
    listingPerformance(agency.id),
    needsAttention(agency.id),
    benchmark(),
    user.role === "admin"
      ? query<{ slug: string; name: string }>(`SELECT slug, name FROM agencies ORDER BY name`)
      : [],
  ]);

  const delta = (now: number, prev: number) => {
    if (prev === 0) return null;
    const pct = Math.round(((now - prev) / prev) * 100);
    return { pct, up: pct >= 0 };
  };

  const Card = ({ label, value, sub, tone }: {
    label: string; value: string; sub?: React.ReactNode; tone?: string;
  }) => (
    <div className="card" style={{ padding: "1rem 1.125rem" }}>
      <div style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em",
                    color: tone, lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: "0.75rem", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );

  const Trend = ({ d }: { d: { pct: number; up: boolean } | null }) =>
    d === null ? null : (
      <span style={{ color: d.up ? "var(--color-fresh)" : "var(--color-danger)", fontWeight: 600 }}>
        {d.up ? "▲" : "▼"} {Math.abs(d.pct)} %
      </span>
    );

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <header style={{ marginBottom: "1.5rem", display: "flex", gap: "1rem",
                       justifyContent: "space-between", flexWrap: "wrap", alignItems: "start" }}>
        <div>
          <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
            {t("dashboard.title")}
          </h1>
          <p style={{ color: "var(--color-ink-soft)", fontSize: "0.9375rem", marginTop: "0.25rem" }}>
            {agency.name} · {t("dashboard.subtitle")} · {t("dashboard.last30")}
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span className="chip" style={{
            background: totals.verification === "verified" ? "var(--color-fresh-soft)" : "var(--color-surface-alt)",
            color: totals.verification === "verified" ? "var(--color-fresh)" : "var(--color-ink-soft)",
            whiteSpace: "normal",
          }}>
            {t(`agency.${totals.verification}`)}
          </span>
          <span className="chip" style={{ background: "var(--color-gold-soft)", color: "var(--color-gold)" }}>
            {totals.tier}
          </span>
          {user.role === "admin" && agencies.length > 0 && (
            <form method="get" style={{ display: "flex", gap: "0.25rem" }}>
              <select className="field" name="agency" defaultValue={agency.slug}
                      style={{ fontSize: "0.8125rem", padding: "0.3125rem 0.5rem" }}
                      aria-label={t("dashboard.chooseAgency")}>
                {agencies.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
              </select>
              <button className="btn btn-outline" style={{ padding: "0.3125rem 0.625rem", fontSize: "0.8125rem" }}>
                →
              </button>
            </form>
          )}
        </div>
      </header>

      <section style={{ display: "grid", gap: "1rem", marginBottom: "1.5rem",
                        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))" }}>
        <Card label={t("dashboard.views")} value={formatNumber(totals.views, locale)}
              sub={<>
                <Trend d={delta(totals.views, totals.viewsPrev)} />{" "}
                {t("dashboard.vsPrevious", { n: formatNumber(totals.viewsPrev, locale) })}
              </>} />
        <Card label={t("dashboard.leads")} value={formatNumber(totals.leads, locale)}
              sub={<>
                <Trend d={delta(totals.leads, totals.leadsPrev)} />{" "}
                {t("dashboard.vsPrevious", { n: formatNumber(totals.leadsPrev, locale) })}
              </>} />
        {/* Le taux seul ne dit rien : il est montré à côté de celui du portail. */}
        <Card label={t("dashboard.conversion")} value={rate(totals.leads, totals.views)}
              sub={t("dashboard.portalAverage", {
                rate: rate(bench?.portalLeads ?? 0, bench?.portalViews ?? 0) })} />
        <Card label={t("dashboard.activeListings")} value={formatNumber(totals.activeListings, locale)}
              tone={totals.activeListings >= totals.quota ? "var(--color-danger)" : undefined}
              sub={t("dashboard.quotaUsed", { used: totals.activeListings, quota: totals.quota })} />
      </section>

      <section className="card" style={{ padding: "1.125rem 1.25rem", marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          {t("dashboard.daily")}
        </h2>
        <Sparkline series={series} labels={{ views: t("dashboard.views"), leads: t("dashboard.leads") }} />
      </section>

      <div style={{ display: "grid", gap: "1.25rem", marginBottom: "1.5rem",
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 20rem), 1fr))" }}>
        <section className="card" style={{ padding: "1.125rem 1.25rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem" }}>
            {t("dashboard.sources")}
          </h2>
          {sources.length === 0 ? <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>{t("dashboard.noData")}</p> : (
            <ul style={{ display: "flex", flexDirection: "column", gap: "0.375rem", fontSize: "0.875rem" }}>
              {sources.map((s) => {
                const pct = Math.round((s.n / sources.reduce((a, x) => a + x.n, 0)) * 100);
                return (
                  <li key={s.source} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ flex: "0 0 9rem", overflow: "hidden", textOverflow: "ellipsis",
                                   whiteSpace: "nowrap" }}>
                      {s.source === "direct" ? t("dashboard.direct") : s.source}
                    </span>
                    <span style={{ flex: 1, height: 6, background: "var(--color-surface-alt)",
                                   borderRadius: 999, overflow: "hidden" }}>
                      <span style={{ display: "block", width: `${pct}%`, height: "100%",
                                     background: "var(--color-brand)" }} />
                    </span>
                    <span style={{ color: "var(--color-ink-faint)", fontSize: "0.75rem" }}>{s.n}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card" style={{ padding: "1.125rem 1.25rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem" }}>
            {t("dashboard.channels")}
          </h2>
          {channels.length === 0 ? <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>{t("dashboard.noData")}</p> : (
            <table style={{ width: "100%", fontSize: "0.875rem", borderCollapse: "collapse" }}>
              <tbody>
                {channels.slice(0, 8).map((c, i) => (
                  <tr key={i} style={{ borderTop: i ? "1px solid var(--color-line-soft)" : undefined }}>
                    <td style={{ padding: "0.3125rem 0" }}>{c.channel}</td>
                    <td style={{ color: "var(--color-ink-faint)" }}>{c.locale.toUpperCase()}</td>
                    <td style={{ textAlign: "end", fontWeight: 600 }}>{c.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card" style={{ padding: "1.125rem 1.25rem", marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          {t("dashboard.performance")}
        </h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "0.875rem", borderCollapse: "collapse", minWidth: "38rem" }}>
            <thead>
              <tr style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)", textAlign: "start" }}>
                <th style={{ textAlign: "start", paddingBottom: "0.375rem" }}>{t("common.reference")}</th>
                <th style={{ textAlign: "start" }}>{t("nav.areas")}</th>
                <th style={{ textAlign: "end" }}>{t("filters.priceRange")}</th>
                <th style={{ textAlign: "end" }}>{t("dashboard.colViews")}</th>
                <th style={{ textAlign: "end" }}>{t("dashboard.colLeads")}</th>
                <th style={{ textAlign: "end" }}>{t("dashboard.colRate")}</th>
                <th style={{ textAlign: "end" }} title={t("dashboard.sharedHint")}>
                  {t("dashboard.colShared")}
                </th>
              </tr>
            </thead>
            <tbody>
              {perf.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                  <td style={{ padding: "0.4375rem 0" }}>
                    <Link href={`/${locale}/property/${p.reference}`} style={{ fontWeight: 600 }}>
                      {p.reference}
                    </Link>
                  </td>
                  <td style={{ color: "var(--color-ink-soft)" }}>{i18nField(p.area, locale)}</td>
                  <td style={{ textAlign: "end" }}>{formatUsd(p.price, locale, true)}</td>
                  <td style={{ textAlign: "end" }}>{formatNumber(p.views, locale)}</td>
                  <td style={{ textAlign: "end", fontWeight: 600 }}>{p.leads}</td>
                  <td style={{ textAlign: "end", color: "var(--color-ink-soft)" }}>
                    {rate(p.leads, p.views)}
                  </td>
                  <td style={{ textAlign: "end", color: p.agencies > 1 ? "var(--color-gold)" : "var(--color-ink-faint)" }}>
                    {p.agencies}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ padding: "1.125rem 1.25rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700 }}>
          {t("dashboard.attention")} ({attention.length})
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", margin: "0.25rem 0 0.75rem" }}>
          {t("dashboard.attentionHint")}
        </p>
        {attention.length === 0 ? (
          <p style={{ fontSize: "0.875rem", color: "var(--color-fresh)" }}>{t("dashboard.attentionEmpty")}</p>
        ) : (
          <ul style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {attention.map((a) => {
              const left = daysUntil(a.expiresAt);
              const stale = daysSince(a.lastConfirmed);
              return (
                <li key={a.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center",
                                        flexWrap: "wrap", fontSize: "0.875rem",
                                        borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.5rem" }}>
                  <Link href={`/${locale}/property/${a.reference}`} style={{ fontWeight: 600 }}>
                    {a.reference}
                  </Link>
                  <span className="chip" style={{
                    background: left <= 7 ? "var(--color-danger-soft)" : "var(--color-stale-soft)",
                    color: left <= 7 ? "var(--color-danger)" : "var(--color-stale)",
                    whiteSpace: "normal",
                  }}>
                    {left <= 7 ? t("dashboard.expiresIn", { n: Math.max(0, left) })
                               : t("dashboard.staleFor", { n: stale })}
                  </span>
                  <span style={{ color: "var(--color-ink-faint)", fontSize: "0.75rem" }}>
                    {formatNumber(a.views, locale)} {t("dashboard.colViews").toLowerCase()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
