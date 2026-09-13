/**
 * Le compteur d'annonces par localité (§5).
 *
 * `locations.listing_count` est dénormalisé parce qu'il est lu partout et
 * calculé nulle part au moment de l'affichage : la page d'accueil range les
 * douze quartiers les plus actifs dessus et écarte ceux à zéro, la boîte de
 * recherche l'affiche au visiteur à côté de chaque suggestion, la page
 * d'estimation s'en sert pour proposer les localités qui ont de la matière.
 *
 * Un chiffre visible qu'aucune écriture ne tient à jour finit par mentir. Il
 * n'était rafraîchi que par `db/seed/activity.mjs` — un script de seed — si
 * bien qu'un import le laissait derrière : mesuré après une collecte de 173
 * annonces, trente localités dérivaient, de 110 pour Phnom Penh. Le
 * rafraîchissement appartient donc au fonctionnement normal, pas au seed.
 *
 * Deux corrections au passage sur le calcul d'origine :
 *
 *   — la descente est RÉCURSIVE. L'ancienne joignait la localité, ses enfants
 *     et ses petits-enfants en dur ; un quatrième niveau serait passé au
 *     travers sans que rien ne le signale ;
 *   — une localité qui n'a plus d'annonce est REMISE À ZÉRO. Un
 *     `UPDATE ... FROM (SELECT … GROUP BY)` ne touche que les lignes que la
 *     sous-requête produit : une localité vidée gardait son dernier chiffre
 *     pour toujours, et la page d'accueil l'aurait annoncée active.
 */

/**
 * Recalcule tous les compteurs et rend le nombre de lignes réellement
 * changées — zéro veut dire « déjà juste », pas « rien fait ».
 *
 * @param {import("pg").Client | import("pg").PoolClient} db
 * @returns {Promise<number>}
 */
export async function refreshLocationCounts(db) {
  const { rowCount } = await db.query(`
    WITH RECURSIVE descendance AS (
      SELECT id AS racine, id FROM locations
      UNION ALL
      SELECT d.racine, l.id FROM descendance d JOIN locations l ON l.parent_id = d.id
    ),
    compte AS (
      SELECT d.racine AS id, count(DISTINCT p.id) AS n
        FROM descendance d
        JOIN properties p ON p.location_id = d.id
        JOIN listings l ON l.property_id = p.id AND l.status = 'active'
       GROUP BY d.racine
    ),
    cible AS (
      SELECT loc.id, COALESCE(c.n, 0)::int AS n
        FROM locations loc LEFT JOIN compte c ON c.id = loc.id
    )
    UPDATE locations SET listing_count = cible.n
      FROM cible
     WHERE locations.id = cible.id
       AND locations.listing_count IS DISTINCT FROM cible.n`);
  return rowCount;
}
