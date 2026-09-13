/**
 * Signalement des prix invraisemblables (§6.1).
 *
 * La collecte reprend fidèlement ce que la source publie, y compris ses
 * erreurs de saisie : une maison à vendre 350 dollars, une autre louée 69 900
 * par mois. Vérifié page par page — le portail publie bien ces montants comme
 * champs structurés. Le tri « le moins cher d'abord » ouvrait donc sur la
 * maison à 350 dollars : le prix faux est le plus visible du catalogue.
 *
 * Ce module ne décide de rien. Il signale, et c'est délibéré : toutes les
 * règles automatiques essayées écartent une majorité de vraies annonces
 * (94 % de faux positifs pour la plus évidente). La machine range, un humain
 * tranche — la même réponse que pour les doublons.
 *
 * Trois garde-fous, chacun mesuré plutôt que choisi :
 *
 *   1. le prix se compare à la MÉDIANE de sa famille (type de bien ×
 *      transaction), pas à un montant absolu : un loyer et un prix de vente
 *      n'ont pas d'échelle commune, ni un studio et une villa ;
 *   2. une famille de moins de MIN_FAMILY_SAMPLE annonces n'a pas de médiane
 *      utilisable — sept locations de terrain ne disent rien du marché, et
 *      c'est ce qui produisait le plus de bruit ;
 *   3. une famille dont l'étendue propre (p90/p10) dépasse déjà le facteur de
 *      signalement échappe au test. Le terrain est dans ce cas, et de loin :
 *      son étendue vaut 72,8 quand aucune autre famille ne dépasse 10,2. Une
 *      parcelle de province à 5 000 dollars et un terrain commercial à
 *      64 millions sont tous deux réels ; leur médiane commune ne sépare rien.
 */

/** Au-delà de ce rapport à la médiane de sa famille, un prix se fait regarder. */
export const PRICE_FACTOR = 20;

/** En dessous, la médiane d'une famille ne dit rien. */
export const MIN_FAMILY_SAMPLE = 30;

/**
 * Les familles de prix et leurs bornes, calculées sur les annonces actives.
 *
 * `testable` porte la décision et son motif : une famille non testable est
 * déclarée telle, jamais silencieusement ignorée.
 */
export async function priceFamilies(db) {
  const { rows } = await db.query(`
    SELECT p.property_type::text AS type, l.transaction_type::text AS transaction,
           count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_usd) AS median,
           percentile_cont(0.10) WITHIN GROUP (ORDER BY l.price_usd) AS p10,
           percentile_cont(0.90) WITHIN GROUP (ORDER BY l.price_usd) AS p90
      FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.status = 'active'
     GROUP BY 1, 2 ORDER BY 1, 2`);
  return rows.map((r) => {
    const median = Number(r.median), p10 = Number(r.p10), p90 = Number(r.p90);
    const spread = p10 > 0 ? p90 / p10 : Infinity;
    let skipped = null;
    if (r.n < MIN_FAMILY_SAMPLE) skipped = `échantillon de ${r.n} annonces`;
    else if (spread > PRICE_FACTOR) skipped = `étendue propre de ${spread.toFixed(1)}`;
    return { ...r, median, p10, p90, spread, testable: skipped === null, skipped };
  });
}

/** Le motif lisible d'un signalement, ou `null` si le prix tient. */
export function priceVerdict(price, family) {
  if (!family?.testable) return null;
  const ratio = price / family.median;
  if (ratio > PRICE_FACTOR) {
    return { ratio, reasons: [`${Math.round(ratio)} fois la médiane de sa famille`] };
  }
  if (ratio < 1 / PRICE_FACTOR) {
    return { ratio, reasons: [`un ${Math.round(1 / ratio)}ᵉ de la médiane de sa famille`] };
  }
  return null;
}

/**
 * Passe la totalité des annonces actives et tient la file à jour.
 *
 * Trois mouvements, et le second compte autant que le premier :
 *
 *   — un prix qui sort des bornes entre en file, s'il n'y est pas déjà ;
 *   — un signalement ouvert dont le prix est revenu dans les bornes en sort,
 *     sans passer par un humain : le prix a changé, il n'y a plus rien à
 *     trancher, et une file qui ne se vide que par décision se remplit de
 *     questions périmées ;
 *   — un prix déjà tranché ne revient pas tant qu'il n'a pas bougé.
 */
export async function reviewPrices(db, { dryRun = false } = {}) {
  const families = await priceFamilies(db);
  const key = (t, x) => `${t}/${x}`;
  const byKey = new Map(families.map((f) => [key(f.type, f.transaction), f]));

  const { rows: listings } = await db.query(`
    SELECT l.id, l.price_usd AS price, p.property_type::text AS type,
           l.transaction_type::text AS transaction, p.reference,
           (SELECT r.id FROM price_reviews r
             WHERE r.listing_id = l.id AND r.reviewed_at IS NULL) AS "openId",
           (SELECT max(r.price_usd) FROM price_reviews r
             WHERE r.listing_id = l.id AND r.reviewed_at IS NOT NULL) AS "settledPrice"
      FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.status = 'active'`);

  const summary = { families: families.length,
                    testable: families.filter((f) => f.testable).length,
                    queued: 0, closed: 0, open: 0, dryRun,
                    skipped: families.filter((f) => !f.testable)
                      .map((f) => `${f.type}/${f.transaction} (${f.skipped})`) };

  for (const l of listings) {
    const price = Number(l.price);
    const verdict = priceVerdict(price, byKey.get(key(l.type, l.transaction)));
    if (verdict && !l.openId) {
      // Déjà tranché à ce prix : la décision tient tant que le prix ne bouge pas.
      if (l.settledPrice !== null && Number(l.settledPrice) === price) continue;
      summary.queued++;
      if (!dryRun) {
        await db.query(
          `INSERT INTO price_reviews(listing_id, price_usd, median_usd, ratio, reasons)
           VALUES ($1,$2,$3,$4,$5)`,
          [l.id, price, byKey.get(key(l.type, l.transaction)).median,
           verdict.ratio.toFixed(3), verdict.reasons]);
      }
    } else if (!verdict && l.openId) {
      summary.closed++;
      if (!dryRun) await db.query(`DELETE FROM price_reviews WHERE id = $1`, [l.openId]);
    }
  }
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int n FROM price_reviews WHERE reviewed_at IS NULL`);
  summary.open = n;
  return summary;
}
