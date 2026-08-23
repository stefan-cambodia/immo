import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";
import { daysUntil, formatDate, formatNumber, formatUsd } from "@/lib/format";
import { getTranslator, i18nField, isLocale, type Locale } from "@/lib/i18n";
import { getMapProvider, PHNOM_PENH } from "@/lib/map-provider";
import { PROPERTY_TYPES, TITLE_TYPES } from "@/lib/search";
import { PinPicker } from "@/components/PinPicker";
import { AuditPanel } from "@/components/AuditPanel";
import { SubmissionQueue, type PendingSubmission } from "@/components/SubmissionQueue";
import { TranslationReview, type PendingTranslation } from "@/components/TranslationReview";
import { auditSpan, countAudit, listAudit, parseAuditFilters } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth";
import { billingOverview, listPlans, openInvoices } from "@/lib/billing";
import { signOut } from "../login/actions";
import { createProperty, resolveDedup, addAlias, confirmListing, pinSubmission,
         approveTranslation, changeTier, issueInvoice, markInvoicePaid,
         voidInvoice, setVerification } from "./actions";

export const dynamic = "force-dynamic";

const Panel = ({ title, hint, children }: {
  title: string; hint?: string; children: React.ReactNode;
}) => (
  <section className="card" style={{ padding: "1.125rem 1.25rem" }}>
    <h2 style={{ fontSize: "1rem", fontWeight: 700 }}>{title}</h2>
    {hint && (
      <p style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)",
                  lineHeight: 1.55, marginTop: "0.25rem", marginBottom: "0.875rem" }}>
        {hint}
      </p>
    )}
    <div style={{ marginTop: hint ? 0 : "0.875rem" }}>{children}</div>
  </section>
);

export default async function BackofficePage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  const sp = await searchParams;
  const { error } = sp;
  const auditFilters = parseAuditFilters(sp);
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const t = await getTranslator(locale);
  const provider = getMapProvider();

  // Le layout a déjà refusé les visiteurs non authentifiés ; cette lecture sert
  // à moduler ce qui est affiché selon le rôle.
  const user = await getCurrentUser();
  if (!user) redirect(`/${locale}/login`);
  const isAdmin = user.role === "admin";
  // Un compte d'agence ne voit que son propre périmètre. Le filtre est passé
  // aux requêtes, pas appliqué après coup sur des données déjà chargées.
  const scope = isAdmin ? null : user.agencyId;

  const [locations, agents, dedup, misses, expiring, reuse, leadStats,
         audit, auditTotal, span, pending, translations,
         billingRows, invoicesOpen, plans, verifRows] = await Promise.all([
    query<{ slug: string; name: Record<string, string>; parent: Record<string, string> | null }>(
      `SELECT l.slug, l.name_i18n AS name, p.name_i18n AS parent
       FROM locations l LEFT JOIN locations p ON p.id = l.parent_id
       WHERE l.level IN ('neighborhood', 'district') ORDER BY l.listing_count DESC`),
    query<{ id: string; name: string; agency: string }>(
      `SELECT ag.id, ag.name, a.name AS agency FROM agents ag
       JOIN agencies a ON a.id = ag.agency_id
       WHERE $1::uuid IS NULL OR ag.agency_id = $1::uuid
       ORDER BY a.name, ag.name`, [scope]),
    isAdmin ? query<{
      id: number; score: string; reasons: string[];
      aRef: string; aType: string; aArea: string; aBeds: number; aFloor: number | null;
      bRef: string; bType: string; bArea: string; bBeds: number; bFloor: number | null;
      aAgency: string; bAgency: string;
    }>(
      `SELECT d.id, d.score, d.reasons,
              a.reference AS "aRef", a.property_type::text AS "aType",
              a.indoor_area_sqm AS "aArea", a.bedrooms AS "aBeds", a.floor AS "aFloor",
              b.reference AS "bRef", b.property_type::text AS "bType",
              b.indoor_area_sqm AS "bArea", b.bedrooms AS "bBeds", b.floor AS "bFloor",
              (SELECT string_agg(DISTINCT ag.name, ', ') FROM listings l
                 JOIN agencies ag ON ag.id = l.agency_id WHERE l.property_id = a.id) AS "aAgency",
              (SELECT string_agg(DISTINCT ag.name, ', ') FROM listings l
                 JOIN agencies ag ON ag.id = l.agency_id WHERE l.property_id = b.id) AS "bAgency"
       FROM dedup_candidates d
       JOIN properties a ON a.id = d.property_a_id
       JOIN properties b ON b.id = d.property_b_id
       WHERE d.reviewed_at IS NULL ORDER BY d.score DESC LIMIT 8`) : [],
    isAdmin ? query<{ id: number; query: string; locale: string; createdAt: string; n: string }>(
      `SELECT min(id) AS id, query, min(locale::text) AS locale,
              max(created_at) AS "createdAt", count(*) AS n
       FROM search_misses WHERE NOT resolved
       GROUP BY query ORDER BY count(*) DESC, max(created_at) DESC LIMIT 10`) : [],
    query<{
      id: string; reference: string; agency: string; agent: string;
      price: string; expiresAt: string; lastConfirmed: string;
    }>(
      `SELECT l.id, p.reference, a.name AS agency, ag.name AS agent,
              l.price_usd AS price, l.expires_at AS "expiresAt",
              l.last_confirmed_at AS "lastConfirmed"
       FROM listings l
       JOIN properties p ON p.id = l.property_id
       JOIN agencies a ON a.id = l.agency_id
       JOIN agents ag ON ag.id = l.agent_id
       WHERE l.status = 'active' AND l.expires_at < now() + interval '7 days'
         AND ($1::uuid IS NULL OR l.agency_id = $1::uuid)
       ORDER BY l.expires_at LIMIT 10`, [scope]),
    // Les photos repiquées sont recompressées et recadrées : elles ne sont
    // jamais identiques bit à bit. La détection porte donc sur la distance
    // entre empreintes, pas sur leur égalité.
    isAdmin ? query<{ hash: string; n: string; refs: string }>(
      `SELECT left(a.phash::text, 16) || '…' AS hash,
              count(DISTINCT b.property_id) + 1 AS n,
              string_agg(DISTINCT pb.reference || ' (d' || phash_distance(a.phash, b.phash) || ')',
                         ', ' ORDER BY pb.reference || ' (d' || phash_distance(a.phash, b.phash) || ')')
                || ' ↔ ' || max(pa.reference) AS refs
       FROM media a
       JOIN media b ON b.id > a.id
                   AND b.property_id <> a.property_id
                   AND phash_distance(a.phash, b.phash) <= 6
       JOIN properties pa ON pa.id = a.property_id
       JOIN properties pb ON pb.id = b.property_id
       GROUP BY a.id, a.phash
       ORDER BY count(DISTINCT b.property_id) DESC LIMIT 8`) : [],
    query<{ channel: string; locale: string; n: string }>(
      `SELECT channel::text, locale::text, count(*) AS n FROM leads
       WHERE created_at > now() - interval '30 days'
         AND ($1::uuid IS NULL OR agency_id = $1::uuid)
       GROUP BY channel, locale ORDER BY count(*) DESC`, [scope]),
    // Le journal est un outil de supervision : il est réservé à la modération.
    // Un compte d'agence ne doit pas savoir ce que fait une agence concurrente.
    isAdmin ? listAudit(auditFilters, 50) : [],
    isAdmin ? countAudit(auditFilters) : 0,
    isAdmin ? auditSpan() : { total: 0, oldest: null, newest: null, purges: 0 },
    // Les soumissions en attente de pin sont cloisonnées comme le reste :
    // une agence ne voit que les siennes.
    query<PendingSubmission>(
      `SELECT s.id, s.source::text, s.external_ref AS "externalRef",
              a.name AS agency, s.normalized, l.name_i18n AS "locationName",
              s.created_at AS "createdAt"
       FROM submissions s
       JOIN agencies a ON a.id = s.agency_id
       LEFT JOIN locations l ON l.id = (s.normalized->>'locationId')::uuid
       WHERE s.status = 'needs_pin'
         AND ($1::uuid IS NULL OR s.agency_id = $1::uuid)
       ORDER BY s.created_at LIMIT 10`, [scope]),
    // §4.1 : seules les annonces premium partent en relecture humaine.
    isAdmin ? query<PendingTranslation>(
      `SELECT l.id, p.reference, a.name AS agency,
              l.description_source_lang::text AS "sourceLang",
              l.description_i18n AS description, l.translated_at AS "translatedAt"
       FROM listings l
       JOIN properties p ON p.id = l.property_id
       JOIN agencies a ON a.id = l.agency_id
       WHERE l.translation_status = 'machine'
         AND a.subscription_tier = 'premium'
       ORDER BY l.translated_at DESC NULLS LAST LIMIT 8`) : [],
    // Facturation : réservée à la modération, comme tout ce qui touche
    // l'argent des autres agences.
    isAdmin ? billingOverview() : [],
    isAdmin ? openInvoices() : [],
    isAdmin ? listPlans() : [],
    // Vérification des agences : le badge est attribué ici, et nulle part
    // ailleurs. Les dossiers en cours d'examen remontent en tête.
    isAdmin ? query<{ id: string; name: string; slug: string; status: string; active: string }>(
      `SELECT a.id, a.name, a.slug, a.verification_status::text AS status,
              (SELECT count(*) FROM listings l
                WHERE l.agency_id = a.id AND l.status = 'active') AS active
       FROM agencies a
       ORDER BY a.verification_status = 'documents_received' DESC,
                a.verification_status = 'unverified' DESC, a.name`) : [],
  ]);

  return (
    <div style={{ maxWidth: "84rem", margin: "0 auto", padding: "1.5rem clamp(0.75rem, 3vw, 1.5rem) 3rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "start",
                      justifyContent: "space-between", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)", fontWeight: 800, letterSpacing: "-0.02em" }}>
            {t("backoffice.title")}
          </h1>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip" style={{
              background: "var(--color-surface-alt)", color: "var(--color-ink-soft)", whiteSpace: "normal",
            }}>
              {t("auth.signedInAs", { name: user.name })}
            </span>
            <span className="chip" style={{
              background: isAdmin ? "var(--color-brand-soft)" : "var(--color-gold-soft)",
              color: isAdmin ? "var(--color-brand)" : "var(--color-gold)",
            }}>
              {t(isAdmin ? "auth.roleAdmin" : "auth.roleAgency")}
            </span>
            <form action={signOut}>
              <input type="hidden" name="locale" value={locale} />
              <button className="btn btn-outline" style={{ padding: "0.3125rem 0.75rem", fontSize: "0.8125rem" }}>
                {t("auth.signOut")}
              </button>
            </form>
          </div>
        </div>
        <p style={{ color: "var(--color-ink-soft)", fontSize: "0.9375rem", marginTop: "0.25rem" }}>
          {t("backoffice.subtitle")}
          {!isAdmin && user.agencyName && (
            <span style={{ display: "block", fontSize: "0.8125rem", marginTop: "0.125rem" }}>
              {t("auth.agencyScope", { agency: user.agencyName })}
            </span>
          )}
        </p>
        {error && (
          <p role="alert" style={{
            marginTop: "0.875rem", padding: "0.75rem 1rem", borderRadius: "0.625rem",
            background: "var(--color-danger-soft)", color: "var(--color-danger)",
            fontSize: "0.875rem", fontWeight: 600,
          }}>
            {error === "pin_required"
              ? t("backoffice.pinRequiredHint")
              : error === "forbidden"
                ? t("auth.forbidden")
                : error === "quota_exceeded"
                  ? t("billing.quotaFull")
                  : error === "invoice_not_issued"
                    ? t("billing.invoiceNotIssued")
                    : String(error)}
          </p>
        )}
      </header>

      <div style={{ display: "grid", gap: "1.25rem",
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 26rem), 1fr))" }}>

        {/* ------------------------------------------------- Saisie d'un bien */}
        <Panel title={t("backoffice.newProperty")}>
          <form action={createProperty}
                style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <input type="hidden" name="locale" value={locale} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                {t("filters.propertyType")}
                <select className="field" name="property_type" defaultValue="condo" style={{ marginTop: "0.25rem" }}>
                  {PROPERTY_TYPES.map((x) => <option key={x} value={x}>{t(`propertyType.${x}`)}</option>)}
                </select>
              </label>
              <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                {t("filters.transaction")}
                <select className="field" name="transaction" defaultValue="sale" style={{ marginTop: "0.25rem" }}>
                  <option value="sale">{t("common.forSale")}</option>
                  <option value="rent">{t("common.forRent")}</option>
                </select>
              </label>
            </div>

            <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
              {t("nav.areas")}
              <select className="field" name="location" required style={{ marginTop: "0.25rem" }}>
                {locations.map((l) => (
                  <option key={l.slug} value={l.slug}>
                    {i18nField(l.name, locale)}
                    {l.parent ? ` — ${i18nField(l.parent, locale)}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
              {t("property.contact")}
              <select className="field" name="agent" required style={{ marginTop: "0.25rem" }}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.agency} — {a.name}</option>
                ))}
              </select>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(6rem, 1fr))", gap: "0.5rem" }}>
              <input className="field" name="price" type="number" min={1} required
                     placeholder="USD" aria-label={t("filters.priceRange")} />
              <input className="field" name="bedrooms" type="number" min={0}
                     placeholder={t("common.bedrooms")} aria-label={t("common.bedrooms")} />
              <input className="field" name="bathrooms" type="number" min={0}
                     placeholder={t("common.bathrooms")} aria-label={t("common.bathrooms")} />
              <input className="field" name="indoor_area" type="number" min={0}
                     placeholder={t("property.indoorArea")} aria-label={t("property.indoorArea")} />
              <input className="field" name="land_area" type="number" min={0}
                     placeholder={t("property.landArea")} aria-label={t("property.landArea")} />
              <input className="field" name="floor" type="number" min={0}
                     placeholder={t("common.floor")} aria-label={t("common.floor")} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                {t("filters.titleType")}
                <select className="field" name="title_type" defaultValue="unknown" style={{ marginTop: "0.25rem" }}>
                  {TITLE_TYPES.map((x) => <option key={x} value={x}>{t(`titleType.${x}`)}</option>)}
                </select>
              </label>
              <label style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                {t("property.machineTranslated", { lang: "" }).split("{")[0].trim() || "Source"}
                <select className="field" name="source_lang" defaultValue={locale} style={{ marginTop: "0.25rem" }}>
                  {["en", "km", "zh", "fr"].map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
                </select>
              </label>
            </div>

            <textarea className="field" name="description" rows={3}
                      placeholder={t("home.searchPlaceholder")}
                      aria-label={t("property.characteristics")} />

            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.875rem" }}>
              <input type="checkbox" name="furnished" value="1" />
              {t("filters.furnished")}
            </label>

            <PinPicker
              style={provider.style}
              attribution={provider.attribution}
              maxZoom={provider.maxZoom}
              center={PHNOM_PENH.center}
              zoom={PHNOM_PENH.zoom}
              labels={{
                required: t("backoffice.pinRequired"),
                hint: t("backoffice.pinRequiredHint"),
                done: t("backoffice.pinSet"),
                submit: t("backoffice.save"),
              }}
            />
          </form>
        </Panel>

        {/* --------------- Soumissions en attente de pin --------------- */}
        <Panel title={`${t("backoffice.submissions")} (${pending.length})`}
               hint={t("backoffice.submissionsHint")}>
          <SubmissionQueue items={pending} locale={locale} t={t}
                           provider={provider} action={pinSubmission} />
        </Panel>

        {/* ------- Relecture des traductions — premium uniquement ------- */}
        {isAdmin && (
        <Panel title={`${t("backoffice.translations")} (${translations.length})`}
               hint={t("backoffice.translationsHint")}>
          <TranslationReview items={translations} locale={locale} t={t}
                             action={approveTranslation} />
        </Panel>
        )}

        {/* File de déduplication — modération uniquement */}
        {isAdmin && (
        <Panel title={`${t("backoffice.dedupQueue")} (${dedup.length})`} hint={t("backoffice.dedupQueueHint")}>
          {dedup.length === 0 && (
            <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>—</p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {dedup.map((d) => (
              <div key={d.id} style={{
                border: "1px solid var(--color-line)", borderRadius: "0.625rem", padding: "0.75rem",
              }}>
                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "space-between", flexWrap: "wrap" }}>
                  <span className="chip" style={{ background: "var(--color-stale-soft)", color: "var(--color-stale)" }}>
                    {Math.round(Number(d.score) * 100)} %
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                    {d.reasons.join(", ")}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem",
                              fontSize: "0.8125rem", marginTop: "0.5rem" }}>
                  {([["aRef", "aType", "aArea", "aBeds", "aFloor", "aAgency"],
                     ["bRef", "bType", "bArea", "bBeds", "bFloor", "bAgency"]] as const).map((keys, i) => (
                    <div key={i} style={{ minWidth: 0 }}>
                      <Link href={`/${locale}/property/${d[keys[0]]}`} style={{ fontWeight: 700 }}>
                        {d[keys[0]]}
                      </Link>
                      <div style={{ color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
                        {t(`propertyType.${d[keys[1]]}`)}<br />
                        {d[keys[2]] ?? "—"} {t("common.sqm")} · {d[keys[3]]} {t("common.bedrooms")}
                        {d[keys[4]] !== null && ` · ${t("common.floor")} ${d[keys[4]]}`}<br />
                        <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                          {d[keys[5]] ?? "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.625rem" }}>
                  <form action={resolveDedup}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="decision" value="merged" />
                    <button className="btn btn-primary" style={{ padding: "0.3125rem 0.75rem", fontSize: "0.8125rem" }}>
                      {t("backoffice.merge")}
                    </button>
                  </form>
                  <form action={resolveDedup}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="decision" value="distinct" />
                    <button className="btn btn-outline" style={{ padding: "0.3125rem 0.75rem", fontSize: "0.8125rem" }}>
                      {t("backoffice.distinct")}
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        )}

        {/* Recherches sans résultat — modération uniquement */}
        {isAdmin && (
        <Panel title={`${t("backoffice.searchMisses")} (${misses.length})`} hint={t("backoffice.searchMissesHint")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {misses.length === 0 && (
              <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>—</p>
            )}
            {misses.map((m) => (
              <form key={m.id} action={addAlias} style={{
                display: "flex", gap: "0.375rem", alignItems: "center", flexWrap: "wrap",
                borderBottom: "1px solid var(--color-line-soft)", paddingBottom: "0.5rem",
              }}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="miss_id" value={m.id} />
                <input type="hidden" name="term" value={m.query} />
                <code style={{
                  fontSize: "0.8125rem", background: "var(--color-surface-alt)",
                  padding: "0.1875rem 0.4375rem", borderRadius: "0.25rem", flex: "1 1 8rem", minWidth: 0,
                }}>
                  {m.query}
                </code>
                <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                  ×{m.n} · {m.locale.toUpperCase()}
                </span>
                <select className="field" name="slug" style={{ flex: "1 1 9rem", fontSize: "0.8125rem", padding: "0.3125rem 0.5rem" }}>
                  {locations.slice(0, 40).map((l) => (
                    <option key={l.slug} value={l.slug}>{i18nField(l.name, locale)}</option>
                  ))}
                </select>
                <button className="btn btn-outline" style={{ padding: "0.3125rem 0.625rem", fontSize: "0.8125rem" }}>
                  {t("backoffice.addAlias")}
                </button>
              </form>
            ))}
          </div>
        </Panel>
        )}

        {/* ------------------------------------------------ Relances J-7 */}
        <Panel title={`${t("backoffice.expiringSoon")} (${expiring.length})`} hint={t("backoffice.expiringSoonHint")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {expiring.length === 0 && (
              <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>—</p>
            )}
            {expiring.map((l) => (
              <form key={l.id} action={confirmListing} style={{
                display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap",
                borderBottom: "1px solid var(--color-line-soft)", paddingBottom: "0.5rem",
              }}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="listing_id" value={l.id} />
                <Link href={`/${locale}/property/${l.reference}`} style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                  {l.reference}
                </Link>
                <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", flex: "1 1 8rem", minWidth: 0 }}>
                  {l.agency} · {formatUsd(l.price, locale, true)}
                </span>
                <span className="chip" style={{
                  background: "var(--color-danger-soft)", color: "var(--color-danger)",
                }}>
                  {t("property.expiresIn", { n: Math.max(0, daysUntil(l.expiresAt)) })}
                </span>
                <button className="btn btn-outline" style={{ padding: "0.3125rem 0.625rem", fontSize: "0.8125rem" }}>
                  {t("backoffice.sendReminder")}
                </button>
              </form>
            ))}
          </div>
        </Panel>

        {/* Photos réutilisées — modération uniquement */}
        {isAdmin && (
        <Panel title={`${t("backoffice.photoReuse")} (${reuse.length})`} hint={t("backoffice.photoReuseHint")}>
          {reuse.length === 0 && <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>—</p>}
          <ul style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.8125rem" }}>
            {reuse.map((r) => (
              <li key={r.hash} style={{ borderBottom: "1px solid var(--color-line-soft)", paddingBottom: "0.5rem" }}>
                <code style={{ color: "var(--color-ink-faint)" }}>{r.hash}</code>
                <span style={{ marginInlineStart: "0.5rem", fontWeight: 600 }}>×{r.n}</span>
                <div style={{ color: "var(--color-ink-soft)", marginTop: "0.125rem", wordBreak: "break-word" }}>
                  {r.refs}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        )}

        {/* -------- Abonnements & facturation — modération uniquement -------- */}
        {isAdmin && (
        <Panel title={t("billing.title")} hint={t("billing.hint")}>
          <div style={{ overflowX: "auto", marginBottom: "1rem" }}>
            <table style={{ width: "100%", fontSize: "0.8125rem", borderCollapse: "collapse", minWidth: "34rem" }}>
              <thead>
                <tr style={{ fontSize: "0.6875rem", color: "var(--color-ink-faint)" }}>
                  <th style={{ textAlign: "start", paddingBottom: "0.375rem" }}>{t("billing.agency")}</th>
                  <th style={{ textAlign: "start" }}>{t("billing.changeTier")}</th>
                  <th style={{ textAlign: "end" }}>{t("billing.quotaListings")}</th>
                  <th style={{ textAlign: "end" }}>{t("billing.featuredSlots")}</th>
                  <th style={{ textAlign: "end" }}>{t("billing.held")}</th>
                  <th style={{ textAlign: "end" }}>{t("billing.invoices")}</th>
                </tr>
              </thead>
              <tbody>
                {billingRows.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                    <td style={{ padding: "0.4375rem 0", fontWeight: 600 }}>
                      <Link href={`/${locale}/dashboard?agency=${a.slug}`}>{a.name}</Link>
                    </td>
                    <td>
                      <form action={changeTier} style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="agency_id" value={a.id} />
                        <select className="field" name="tier" defaultValue={a.tier}
                                aria-label={t("billing.changeTier")}
                                style={{ fontSize: "0.75rem", padding: "0.1875rem 0.375rem" }}>
                          {plans.map((p) => (
                            <option key={p.tier} value={p.tier}>
                              {t(`billing.tier_${p.tier}`)} — {formatUsd(p.priceUsdMonth, locale, true)}
                            </option>
                          ))}
                        </select>
                        <button className="btn btn-outline" style={{ padding: "0.1875rem 0.5rem", fontSize: "0.75rem" }}>
                          ✓
                        </button>
                      </form>
                    </td>
                    <td style={{ textAlign: "end",
                                 color: a.activeListings >= a.listingQuota ? "var(--color-danger)" : undefined }}>
                      {a.activeListings}/{a.listingQuota}
                    </td>
                    <td style={{ textAlign: "end" }}>{a.featuredActive}/{a.featuredQuota}</td>
                    <td style={{ textAlign: "end",
                                 color: a.heldListings > 0 ? "var(--color-stale)" : "var(--color-ink-faint)" }}>
                      {a.heldListings}
                    </td>
                    <td style={{ textAlign: "end", whiteSpace: "nowrap" }}>
                      {a.overdueInvoices > 0 && (
                        <span className="chip" style={{
                          background: "var(--color-danger-soft)", color: "var(--color-danger)",
                          marginInlineEnd: "0.25rem",
                        }}>
                          {t("billing.overdue")} ×{a.overdueInvoices}
                        </span>
                      )}
                      {Number(a.priceUsdMonth) > 0 && (
                        <form action={issueInvoice} style={{ display: "inline" }}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="agency_id" value={a.id} />
                          <button className="btn btn-outline"
                                  title={t("billing.issueInvoice")}
                                  style={{ padding: "0.1875rem 0.5rem", fontSize: "0.75rem" }}>
                            + {t("billing.invoices")}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ fontSize: "0.875rem", fontWeight: 700, marginBottom: "0.5rem" }}>
            {t("billing.openInvoices")} ({invoicesOpen.length})
          </h3>
          {invoicesOpen.length === 0 ? (
            <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)" }}>{t("billing.noInvoices")}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {invoicesOpen.map((i) => (
                <div key={i.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center",
                                         flexWrap: "wrap", fontSize: "0.8125rem",
                                         borderTop: "1px solid var(--color-line-soft)", paddingTop: "0.5rem" }}>
                  <code style={{ fontWeight: 600 }}>{i.number}</code>
                  <span style={{ flex: "1 1 10rem", minWidth: 0, color: "var(--color-ink-soft)" }}>
                    {i.agencyName} · {formatUsd(i.amountUsd, locale)} · {formatDate(i.periodStart, locale)}
                  </span>
                  <span className="chip" style={{
                    background: i.overdue ? "var(--color-danger-soft)" : "var(--color-surface-alt)",
                    color: i.overdue ? "var(--color-danger)" : "var(--color-ink-soft)",
                  }}>
                    {i.overdue ? t("billing.overdue") : t("billing.colDue")} — {formatDate(i.dueAt, locale)}
                  </span>
                  <form action={markInvoicePaid} style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="invoice_id" value={i.id} />
                    <input className="field" name="note" placeholder={t("billing.paidRef")}
                           style={{ fontSize: "0.75rem", padding: "0.1875rem 0.375rem", width: "9rem" }} />
                    <button className="btn btn-primary" style={{ padding: "0.1875rem 0.5rem", fontSize: "0.75rem" }}>
                      {t("billing.markPaid")}
                    </button>
                  </form>
                  <form action={voidInvoice}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="invoice_id" value={i.id} />
                    <button className="btn btn-outline" style={{ padding: "0.1875rem 0.5rem", fontSize: "0.75rem" }}>
                      {t("billing.voidInvoice")}
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </Panel>
        )}

        {/* -------- Vérification des agences — modération uniquement -------- */}
        {isAdmin && (
        <Panel title={t("backoffice.verification")} hint={t("backoffice.verificationHint")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {verifRows.map((a) => (
              <form key={a.id} action={setVerification} style={{
                display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap",
                borderBottom: "1px solid var(--color-line-soft)", paddingBottom: "0.5rem",
              }}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="agency_id" value={a.id} />
                <Link href={`/${locale}/agency/${a.slug}`}
                      style={{ fontWeight: 600, fontSize: "0.875rem", flex: "1 1 10rem", minWidth: 0 }}>
                  {a.name}
                </Link>
                <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                  {t("agency.listingsCount", { n: formatNumber(a.active, locale) })}
                </span>
                <span className="chip" style={{
                  background: a.status === "verified" ? "var(--color-fresh-soft)"
                    : a.status === "documents_received" ? "var(--color-gold-soft)"
                    : "var(--color-surface-alt)",
                  color: a.status === "verified" ? "var(--color-fresh)"
                    : a.status === "documents_received" ? "var(--color-gold)"
                    : "var(--color-ink-soft)",
                }}>
                  {t(`agency.${a.status}`)}
                </span>
                <select className="field" name="status" defaultValue={a.status}
                        aria-label={t("backoffice.verification")}
                        style={{ fontSize: "0.75rem", padding: "0.1875rem 0.375rem" }}>
                  {["unverified", "documents_received", "verified"].map((s) => (
                    <option key={s} value={s}>{t(`agency.${s}`)}</option>
                  ))}
                </select>
                <button className="btn btn-outline" style={{ padding: "0.1875rem 0.5rem", fontSize: "0.75rem" }}>
                  ✓
                </button>
              </form>
            ))}
          </div>
        </Panel>
        )}

        {/* ---------- Journal d'audit — modération uniquement ---------- */}
        {isAdmin && (
        <Panel title={t("backoffice.auditLog")} hint={t("backoffice.auditLogHint")}>
          <AuditPanel rows={audit} total={auditTotal} span={span}
                      filters={auditFilters} locale={locale} t={t} />
        </Panel>
        )}

        {/* ------------------------------------------------------- Leads */}
        <Panel title={`${t("backoffice.leads")} — 30 ${t("filters.days")}`}>
          {leadStats.length === 0 ? (
            <p style={{ fontSize: "0.875rem", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
              {t("common.noResults")}
            </p>
          ) : (
            <table style={{ width: "100%", fontSize: "0.875rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "start", color: "var(--color-ink-faint)", fontSize: "0.75rem" }}>
                  <th style={{ textAlign: "start", paddingBottom: "0.375rem" }}>Canal</th>
                  <th style={{ textAlign: "start", paddingBottom: "0.375rem" }}>Locale</th>
                  <th style={{ textAlign: "end", paddingBottom: "0.375rem" }}>N</th>
                </tr>
              </thead>
              <tbody>
                {leadStats.map((s, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                    <td style={{ padding: "0.375rem 0" }}>{s.channel}</td>
                    <td>{s.locale.toUpperCase()}</td>
                    <td style={{ textAlign: "end", fontWeight: 600 }}>{formatNumber(s.n, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
