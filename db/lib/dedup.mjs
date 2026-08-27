import { PHASH_SAME, PHASH_MAYBE } from "./phash.mjs";

/**
 * Moteur de déduplication (§6.2).
 *
 * Trois issues, et une règle qui prime sur tout le reste : « ne jamais laisser
 * l'algorithme fusionner seul les cas ambigus ». La fusion automatique n'est
 * donc réservée qu'aux correspondances déterministes — celles où deux annonces
 * décrivent la même unité d'un immeuble identifié. Tout le reste part en file
 * de validation, y compris ce qui « semble » évident.
 *
 * Les photos corroborent, elles ne décident pas : un dHash ne lit que la
 * structure grossière d'une image, et deux studios identiques du même immeuble
 * peuvent produire la même empreinte (cf. src/lib/phash.ts).
 */

const area = (v) => (v === null ? null : Number(v));

/** Écart relatif entre deux surfaces, ou null si l'une manque. */
function areaDelta(a, b) {
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

/**
 * Au-delà de cet écart, les surfaces ne décrivent plus le même bien. Mesuré
 * sur les annonces collectées : la file contenait une villa de 184 m² appariée
 * à une de 684 m², parce que le score n'additionnait que des accords et
 * qu'un désaccord franc ne pesait rien.
 */
const AREA_INCOMPATIBLE = 0.25;

/** Score à partir duquel une paire mérite d'être regardée par un humain. */
export const QUEUE_THRESHOLD = 0.3;

/**
 * Note une paire (candidat vs bien existant). Extraite pour que la file de
 * validation puisse être RÉÉVALUÉE avec les mêmes règles une fois les
 * empreintes de photos calculées — voir db/jobs/rescan-duplicates.mjs. La
 * règle ne doit pas exister en deux exemplaires.
 */
export function scoreMatch(input, row) {
  const inputArea = input.indoorAreaSqm ?? input.landAreaSqm;
  const reasons = [];
  let score = 0;

  const sameBuilding = input.buildingId !== null && row.building_id === input.buildingId;
  const sameFloor = input.floor !== null && row.floor !== null && row.floor === input.floor;
  const sameBeds = row.bedrooms === input.bedrooms;
  const delta = areaDelta(inputArea, area(row.indoor_area_sqm) ?? area(row.land_area_sqm));
  const photo = row.photo_distance;

  if (sameBuilding) { score += 0.35; reasons.push("même immeuble"); }
  if (sameFloor)    { score += 0.20; reasons.push("même étage"); }
  if (sameBeds)     { score += 0.10; reasons.push("même nombre de chambres"); }
  if (delta !== null && delta <= 0.02) { score += 0.25; reasons.push("surface identique à 2 %"); }
  else if (delta !== null && delta <= 0.10) { score += 0.12; reasons.push("surface proche à 10 %"); }
  // Le désaccord compte, lui aussi : sans cela, deux biens que tout sépare se
  // rejoignent sur un numéro d'étage et un nombre de chambres.
  else if (delta !== null && delta > AREA_INCOMPATIBLE) {
    score -= 0.20; reasons.push(`surface incompatible (${Math.round(delta * 100)} %)`);
  }

  if (photo !== null && photo <= PHASH_SAME) {
    score += 0.20; reasons.push(`photo identique (distance ${photo})`);
  } else if (photo !== null && photo <= PHASH_MAYBE) {
    score += 0.08; reasons.push(`photo ressemblante (distance ${photo})`);
  }

  // Une agence face à sa propre annonce : c'est une mise à jour, pas un
  // doublon inter-agences. Le rapprochement reste possible mais ne doit
  // jamais partir en fusion automatique sous ce motif.
  const ownListing = Boolean(input.agencyId && row.agency_ids.includes(input.agencyId));
  if (ownListing) reasons.push("annonce de la même agence");

  // Correspondance forte, seule autorisée à fusionner sans humain : la même
  // unité d'un immeuble identifié. Immeuble + étage + chambres + surface à
  // 2 % ne laisse pas de place à l'interprétation.
  const strong = sameBuilding && sameFloor && sameBeds && delta !== null && delta <= 0.02;

  /**
   * Ce qui autorise à déranger un humain.
   *
   * Sans immeuble identifié, l'accord structurel ne distingue pas « la même
   * unité » de « l'unité identique d'à côté » : un 58 m² d'une chambre au
   * douzième étage décrit des centaines d'appartements de Tonlé Bassac. Mesuré
   * sur les annonces collectées : 95 % des paires en file avaient des photos
   * sans aucun rapport.
   *
   * La corroboration n'est donc exigée QUE si les photos ont pu être
   * regardées. Un canal qui n'apporte pas d'empreintes — le flux CRM, le bot
   * avant traitement des images — retombe sur le comportement d'origine :
   * mieux vaut une file trop large qu'un doublon publié sans que personne ne
   * l'ait vu.
   */
  const corroborated = sameBuilding || (photo !== null && photo <= PHASH_MAYBE);

  return { score: Math.min(1, Math.max(0, score)), reasons, strong, ownListing,
           photo, delta, corroborated };
}

/** @param {import("pg").PoolClient | import("pg").Client} db */
export async function findDuplicates(db, input) {
  // Présélection large côté base : même immeuble, ou même quartier et même
  // type. La comparaison fine se fait ensuite en TypeScript, où les règles
  // restent lisibles et testables.
  const { rows } = await db.query(
    `
    WITH candidate AS (
      SELECT p.id, p.reference, p.building_id, p.location_id,
             p.property_type::text, p.floor, p.bedrooms,
             p.indoor_area_sqm, p.land_area_sqm,
             ARRAY(SELECT DISTINCT l.agency_id::text FROM listings l
                    WHERE l.property_id = p.id AND l.status = 'active') AS agency_ids
      FROM properties p
      WHERE (($1::uuid IS NOT NULL AND p.building_id = $1::uuid)
             OR (p.location_id = $2::uuid AND p.property_type = $3::property_type))
        -- Un bien déjà en base repassé par le moteur (rescan-duplicates) se
        -- trouverait lui-même : même immeuble, même étage, photo à distance 0,
        -- score maximal. Il masquerait alors son vrai doublon, classé second.
        AND ($5::uuid IS NULL OR p.id <> $5::uuid)
    )
    SELECT c.*,
           (SELECT min(phash_distance(m.phash, x.h))
            FROM media m, unnest($4::bit(64)[]) AS x(h)
            WHERE m.property_id = c.id AND m.phash IS NOT NULL) AS photo_distance
    FROM candidate c
    LIMIT 500
    `,
    [input.buildingId, input.locationId, input.propertyType,
     input.phashes?.length ? input.phashes : null,
     input.excludeId ?? null]
  );

  // Les photos n'ont pu être regardées que si le canal en a fourni : c'est ce
  // qui décide si la corroboration peut être exigée (voir `scoreMatch`).
  const photosKnown = Boolean(input.phashes?.length);
  const scored = rows.map((row) => ({ row, ...scoreMatch(input, row) }));

  scored.sort((a, b) => b.score - a.score);

  const eligible = scored.filter((s) => s.score >= QUEUE_THRESHOLD
                                     && (!photosKnown || s.corroborated));
  const best = eligible[0];

  const candidates = eligible
    .slice(0, 5)
    .map((s) => ({
      propertyId: s.row.id, reference: s.row.reference,
      score: Number(s.score.toFixed(3)), reasons: s.reasons,
    }));

  if (!best) {
    const top = scored[0];
    return { decision: "new", propertyId: null, score: top ? Number(top.score.toFixed(3)) : 0,
             reasons: top
               ? (photosKnown && top.score >= QUEUE_THRESHOLD
                   ? ["accord structurel sans corroboration"]
                   : ["aucune correspondance suffisante"])
               : ["aucun bien comparable"],
             candidates: [] };
  }

  if (best.strong && !best.ownListing) {
    return { decision: "merge", propertyId: best.row.id, score: Number(best.score.toFixed(3)),
             reasons: best.reasons, candidates: candidates.slice(1) };
  }

  // Tout le reste — y compris une correspondance photo parfaite sans
  // corroboration structurelle — passe par un humain.
  return { decision: "review", propertyId: best.row.id, score: Number(best.score.toFixed(3)),
           reasons: best.reasons, candidates };
}

/**
 * Dépose une paire dans la file de validation, sans jamais fusionner (§6.2).
 *
 * Renvoie `true` si la paire est NOUVELLE. Une réévaluation rejouée doit
 * pouvoir dire ce qu'elle a réellement ajouté : compter les tentatives ferait
 * annoncer « 44 paires déposées » à chaque passage, y compris à vide.
 */
export async function queueForReview(db, newPropertyId, matchId, score, reasons) {
  const [a, b] = newPropertyId < matchId ? [newPropertyId, matchId] : [matchId, newPropertyId];
  const { rowCount } = await db.query(
    `INSERT INTO dedup_candidates(property_a_id, property_b_id, score, reasons)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [a, b, score, reasons]
  );
  return rowCount > 0;
}
