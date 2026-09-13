-- =====================================================================
-- File de modération des prix invraisemblables (§6.1, canal 4).
--
-- Trois annonces sur 3 405 portent un prix manifestement faux : une
-- maison à vendre 350 dollars, une autre louée 69 900 par mois, un
-- terrain loué 170 000. Vérification faite sur les pages de la source,
-- la collecte n'y est pour rien — le portail publie ces montants comme
-- champs structurés. C'est l'annonceur qui s'est trompé de case.
--
-- Le tri « le moins cher d'abord » ouvrait donc sur la maison à 350
-- dollars : le prix faux est le plus visible du catalogue.
--
-- On ne les écarte PAS automatiquement, et ce n'est pas un renoncement,
-- c'est une mesure. Toutes les règles essayées signalent une majorité de
-- vraies annonces : comparer à la médiane de la transaction opposée
-- donne 94 % de faux positifs, comparer aux propres centiles de la
-- famille n'améliore rien. Le marché va légitimement de la parcelle de
-- province au penthouse de Tonlé Bassac, et aucun seuil ne les sépare.
--
-- Donc la même réponse que pour les doublons (§6.2) : la machine
-- signale, un humain tranche. L'annonce reste publiée tant que personne
-- n'a regardé — la retirer sur un soupçon coûterait plus cher que le
-- prix faux qu'on corrige.
-- =====================================================================

CREATE TABLE price_reviews (
  id           bigserial PRIMARY KEY,
  listing_id   uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  -- Le prix ET sa référence au moment du signalement : une décision se
  -- relit des mois plus tard, quand la médiane du marché a bougé.
  price_usd    numeric(12,2) NOT NULL,
  median_usd   numeric(12,2) NOT NULL,
  ratio        numeric(10,3) NOT NULL,
  reasons      text[] NOT NULL DEFAULT '{}',
  reviewed_at  timestamptz,
  decision     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_reviews_decision CHECK
    (decision IS NULL OR decision IN ('sound', 'wrong')),
  CONSTRAINT price_reviews_reviewed CHECK
    ((reviewed_at IS NULL) = (decision IS NULL))
);

-- Une annonce n'a qu'un signalement ouvert à la fois. Un signalement déjà
-- tranché ne revient pas tant que le prix n'a pas changé : c'est le job
-- qui le vérifie, sur `price_usd`.
CREATE UNIQUE INDEX price_reviews_open ON price_reviews(listing_id)
  WHERE reviewed_at IS NULL;
CREATE INDEX price_reviews_listing_idx ON price_reviews(listing_id, created_at DESC);
