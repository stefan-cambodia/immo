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

/** @param {import("pg").PoolClient | import("pg").Client} db */
export async function findDuplicates(db, input) {
  const inputArea = input.indoorAreaSqm ?? input.landAreaSqm;

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
    )
    SELECT c.*,
           (SELECT min(phash_distance(m.phash, x.h))
            FROM media m, unnest($4::bit(64)[]) AS x(h)
            WHERE m.property_id = c.id AND m.phash IS NOT NULL) AS photo_distance
    FROM candidate c
    LIMIT 500
    `,
    [input.buildingId, input.locationId, input.propertyType,
     input.phashes?.length ? input.phashes : null]
  );

  const scored = rows.map((row) => {
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

    return { row, score: Math.min(1, score), reasons, strong, ownListing, photo, delta };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  const candidates = scored
    .filter((s) => s.score >= 0.3)
    .slice(0, 5)
    .map((s) => ({
      propertyId: s.row.id, reference: s.row.reference,
      score: Number(s.score.toFixed(3)), reasons: s.reasons,
    }));

  if (!best || best.score < 0.3) {
    return { decision: "new", propertyId: null, score: best ? Number(best.score.toFixed(3)) : 0,
             reasons: best ? ["aucune correspondance suffisante"] : ["aucun bien comparable"],
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

/** Dépose une paire dans la file de validation, sans jamais fusionner (§6.2). */
export async function queueForReview(db, newPropertyId, matchId, score, reasons) {
  const [a, b] = newPropertyId < matchId ? [newPropertyId, matchId] : [matchId, newPropertyId];
  await db.query(
    `INSERT INTO dedup_candidates(property_a_id, property_b_id, score, reasons)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [a, b, score, reasons]
  );
}
