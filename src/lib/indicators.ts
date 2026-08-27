import "server-only";
import { query, queryOne } from "./db";

/**
 * Indicateurs de santé du portail (§10 de la roadmap).
 *
 * Le brief fixe huit indicateurs et une cible de fin de phase 2 pour chacun.
 * Ils étaient suivis nulle part : le back-office montrait des files de travail
 * — soumissions, doublons, recherches sans résultat — mais aucun chiffre disant
 * si le produit avance vers ses cibles. C'est ce que ce module calcule, en une
 * seule requête, pour un panneau de modération.
 *
 * Deux principes ont guidé les définitions :
 *
 * 1. UN INDICATEUR QU'ON NE SAIT PAS MESURER SE DÉCLARE NON MESURÉ. C'est ce
 *    qui a fait instrumenter les deux qui manquaient : le LCP se mesure
 *    désormais dans les navigateurs réels (`web_vitals`), et le taux de
 *    recherches sans résultat a gagné son dénominateur (`search_events`). Les
 *    deux restent muets tant que la donnée n'est pas là — sous le seuil
 *    d'échantillon pour le centile, sans aucune recherche mesurée pour le
 *    taux. Afficher un chiffre faux serait pire que de montrer un trou.
 *
 * 2. UNE APPROXIMATION SE DIT COMME TELLE. Les « doublons résiduels » ne sont
 *    pas observables directement : on ne connaît pas les doublons que le
 *    moteur a laissés passer. Ce qui est mesuré est la part des biens engagés
 *    dans au moins une paire non tranchée — un majorant, et un signal
 *    d'arriéré de modération autant que de qualité.
 */

/** Fenêtre d'observation par défaut, en jours. */
export const WINDOW_DAYS = 30;

/**
 * En dessous de ce nombre de mesures, un centile ne dit rien. Même discipline
 * que l'estimation de prix : mieux vaut se taire que produire un chiffre
 * précis à partir de trois relevés.
 */
export const MIN_VITALS_SAMPLE = 20;

export type IndicatorStatus = "met" | "close" | "off" | "unmeasured";

export interface Indicator {
  /** Clé de traduction, sous `indicators.` */
  key: string;
  /** Famille du brief : offre, qualité, ingestion, usage, technique, langues. */
  group: string;
  /** Valeur mesurée, ou null si l'indicateur n'est pas mesurable en l'état. */
  value: number | null;
  unit: "count" | "percent" | "ratio" | "ms";
  /** Cible de fin de phase 2, telle que le brief la fixe. */
  target: number | null;
  /** Sens de la comparaison : la valeur doit-elle dépasser ou rester sous la cible ? */
  direction: "up" | "down";
  status: IndicatorStatus;
  /** Détail chiffré qui rend la valeur vérifiable (numérateur / dénominateur). */
  detail?: string;
}

interface Raw {
  activeProperties: number;
  activeListings: number;
  confirmedRecent: number;
  dedupOpen: number;
  dedupPairs: number;
  properties: number;
  misses: number;
  botListings: number;
  recentListings: number;
  leads: number;
  sessions: number;
  searches: number;
  searchesFailed: number;
  lcpSamples: number;
  lcpP75: number | null;
}

/**
 * Une valeur est « proche » à moins d'un dixième de la cible. La nuance
 * compte : un indicateur à 68 % pour une cible de 70 % ne demande pas la même
 * réaction qu'un indicateur à 12 %.
 */
function statusFor(value: number | null, target: number | null, direction: "up" | "down"): IndicatorStatus {
  if (value === null) return "unmeasured";
  if (target === null) return "met";
  const met = direction === "up" ? value >= target : value <= target;
  if (met) return "met";
  const margin = Math.abs(target) * 0.1;
  const close = direction === "up" ? value >= target - margin : value <= target + margin;
  return close ? "close" : "off";
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export async function indicators(days = WINDOW_DAYS): Promise<Indicator[]> {
  const r = await queryOne<Raw>(
    `
    SELECT
      (SELECT count(DISTINCT property_id) FROM listings WHERE status = 'active')::int
        AS "activeProperties",
      (SELECT count(*) FROM listings WHERE status = 'active')::int AS "activeListings",
      (SELECT count(*) FROM listings
        WHERE status = 'active' AND last_confirmed_at > now() - make_interval(days => $1::int))::int
        AS "confirmedRecent",
      -- Des PAIRES rapportées à des BIENS ne font pas un taux : un même bien
      -- apparaît dans plusieurs paires, et le rapport dépasse allègrement
      -- 100 %. Ce qui se rapporte aux biens, ce sont les biens concernés.
      (SELECT count(*) FROM (
         SELECT property_a_id AS id FROM dedup_candidates WHERE reviewed_at IS NULL
         UNION
         SELECT property_b_id FROM dedup_candidates WHERE reviewed_at IS NULL
       ) x)::int AS "dedupOpen",
      (SELECT count(*) FROM dedup_candidates WHERE reviewed_at IS NULL)::int AS "dedupPairs",
      (SELECT count(*) FROM properties)::int AS properties,
      (SELECT count(*) FROM search_misses
        WHERE created_at > now() - make_interval(days => $1::int))::int AS misses,
      (SELECT count(*) FROM listings
        WHERE source = 'telegram_bot'
          AND created_at > now() - make_interval(days => $1::int))::int AS "botListings",
      (SELECT count(*) FROM listings
        WHERE created_at > now() - make_interval(days => $1::int))::int AS "recentListings",
      (SELECT count(*) FROM leads
        WHERE created_at > now() - make_interval(days => $1::int))::int AS leads,
      (SELECT count(DISTINCT session_id) FROM property_views
        WHERE created_at > now() - make_interval(days => $1::int))::int AS sessions,
      (SELECT count(*) FROM search_events
        WHERE created_at > now() - make_interval(days => $1::int))::int AS searches,
      (SELECT count(*) FROM search_events
        WHERE NOT resolved
          AND created_at > now() - make_interval(days => $1::int))::int AS "searchesFailed",
      (SELECT count(*) FROM web_vitals
        WHERE metric = 'lcp' AND form_factor = 'mobile'
          AND created_at > now() - make_interval(days => $1::int))::int AS "lcpSamples",
      (SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY value_ms)
         FROM web_vitals
        WHERE metric = 'lcp' AND form_factor = 'mobile'
          AND created_at > now() - make_interval(days => $1::int))::int AS "lcpP75"
    `,
    [days]
  );
  const d = r!;

  const confirmed = pct(d.confirmedRecent, d.activeListings);
  const dedupRate = pct(d.dedupOpen, d.properties);
  const botShare = pct(d.botListings, d.recentListings);
  const leadsPerK = d.sessions > 0
    ? Math.round((d.leads / d.sessions) * 1000 * 10) / 10
    : null;
  const missRate = pct(d.searchesFailed, d.searches);
  const lcp = d.lcpSamples >= MIN_VITALS_SAMPLE ? d.lcpP75 : null;

  const list: Indicator[] = [
    {
      key: "activeProperties", group: "supply", value: d.activeProperties,
      unit: "count", target: 3000, direction: "up",
      status: statusFor(d.activeProperties, 3000, "up"),
      detail: `${d.activeListings} annonces actives`,
    },
    {
      key: "confirmedRecent", group: "supply", value: confirmed,
      unit: "percent", target: 70, direction: "up",
      status: statusFor(confirmed, 70, "up"),
      detail: `${d.confirmedRecent} / ${d.activeListings}`,
    },
    {
      key: "dedupResidual", group: "quality", value: dedupRate,
      unit: "percent", target: 5, direction: "down",
      status: statusFor(dedupRate, 5, "down"),
      detail: `${d.dedupOpen} / ${d.properties} biens, ${d.dedupPairs} paires en file`,
    },
    {
      // Le dénominateur vient de `search_events` : les recherches en texte
      // libre, dédoublonnées par session et par jour. `search_misses` garde à
      // part le TEXTE des échecs, qui sert à écrire les alias (§5.2) ; ici
      // c'est le taux qui compte.
      key: "searchMisses", group: "quality", value: missRate,
      unit: "percent", target: 8, direction: "down",
      status: statusFor(missRate, 8, "down"),
      detail: d.searches > 0
        ? `${d.searchesFailed} / ${d.searches} recherches, ${d.misses} textes retenus`
        : `aucune recherche mesurée sur ${days} j`,
    },
    {
      key: "botShare", group: "ingestion", value: botShare,
      unit: "percent", target: 60, direction: "up",
      status: statusFor(botShare, 60, "up"),
      detail: `${d.botListings} / ${d.recentListings} annonces sur ${days} j`,
    },
    {
      key: "leadsPerThousand", group: "usage", value: leadsPerK,
      unit: "ratio", target: null, direction: "up",
      status: statusFor(leadsPerK, null, "up"),
      detail: `${d.leads} contacts / ${d.sessions} sessions`,
    },
    {
      // Mesure de terrain, remontée par les navigateurs réels (§7). En
      // dessous du seuil d'échantillon, le centile n'est pas publié.
      key: "lcp", group: "technical", value: lcp,
      unit: "ms", target: 3000, direction: "down",
      status: statusFor(lcp, 3000, "down"),
      detail: `${d.lcpSamples} mesures mobiles sur ${days} j`
        + (d.lcpSamples < MIN_VITALS_SAMPLE ? `, minimum ${MIN_VITALS_SAMPLE}` : ""),
    },
  ];

  return list;
}

/** Répartition du trafic par langue : elle pilote les priorités de traduction (§10). */
export function localeMix(days = WINDOW_DAYS) {
  return query<{ locale: string; views: number; share: number }>(
    `
    WITH v AS (
      SELECT locale::text AS locale, count(*)::int AS views
      FROM property_views WHERE created_at > now() - make_interval(days => $1::int)
      GROUP BY 1
    )
    SELECT locale, views,
           round(views * 100.0 / NULLIF(sum(views) OVER (), 0), 1)::float AS share
    FROM v ORDER BY views DESC
    `,
    [days]
  );
}
