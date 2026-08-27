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
 * 1. UN INDICATEUR QU'ON NE SAIT PAS MESURER SE DÉCLARE NON MESURÉ. Deux des
 *    huit le sont : le LCP demande une mesure côté navigateur qui n'existe pas
 *    encore, et le taux de recherches sans résultat demande un dénominateur —
 *    le nombre de recherches abouties — qui n'est pas journalisé. Afficher un
 *    chiffre faux serait pire que de montrer un trou, puisque c'est
 *    précisément ce trou qui dit quoi instrumenter ensuite.
 *
 * 2. UNE APPROXIMATION SE DIT COMME TELLE. Les « doublons résiduels » ne sont
 *    pas observables directement : on ne connaît pas les doublons que le
 *    moteur a laissés passer. Ce qui est mesuré est la part des biens engagés
 *    dans au moins une paire non tranchée — un majorant, et un signal
 *    d'arriéré de modération autant que de qualité.
 */

/** Fenêtre d'observation par défaut, en jours. */
export const WINDOW_DAYS = 30;

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
        WHERE created_at > now() - make_interval(days => $1::int))::int AS sessions
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
      // Le taux demanderait le nombre de recherches abouties, qui n'est pas
      // journalisé — seuls les échecs le sont. On montre donc le volume brut,
      // qui reste la matière première de la table d'alias (§5.2).
      key: "searchMisses", group: "quality", value: null,
      unit: "percent", target: 8, direction: "down", status: "unmeasured",
      detail: `${d.misses} recherches sans résultat sur ${days} j`,
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
      // Mesure de terrain : elle ne peut venir que des navigateurs réels.
      key: "lcp", group: "technical", value: null,
      unit: "ms", target: 3000, direction: "down", status: "unmeasured",
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
