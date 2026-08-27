-- =====================================================================
-- Les deux mesures qui manquaient aux indicateurs (§10).
--
-- Le panneau de santé du back-office affichait deux indicateurs sur huit
-- comme « non mesurés ». Ce n'était pas un oubli d'affichage : la donnée
-- n'existait pas. Cette migration la crée.
--
-- 1. LE DÉNOMINATEUR DES RECHERCHES. `search_misses` ne retient que les
--    échecs — c'est ce qu'il faut pour nourrir la table d'alias (§5.2),
--    mais un numérateur seul ne fait pas un taux. Sans le nombre de
--    recherches abouties, « moins de 8 % de recherches sans résultat »
--    n'est pas vérifiable.
--
-- 2. LE LCP. C'est une mesure de TERRAIN : elle ne peut venir que des
--    navigateurs réels, sur leurs réseaux réels. Aucune requête SQL ne la
--    produira, et un test synthétique en salle mesure autre chose — le
--    brief vise explicitement le p75 mobile sur 4G (§7).
--
-- Trois règles communes aux deux tables, héritées de `property_views` :
--
--   - AUCUNE DONNÉE PERSONNELLE. Pas d'adresse IP, pas d'URL complète, pas
--     d'identifiant durable. La session est un jeton opaque posé par le
--     client, qui ne sert qu'au dédoublonnage.
--   - PAS DE TEXTE DE RECHERCHE ABOUTIE. Le dédoublonnage n'a besoin que
--     d'une empreinte ; le texte des recherches qui ont marché n'a aucun
--     usage ici, et `search_misses` garde déjà celui des échecs.
--   - DES MESURES, PAS DES ARCHIVES. Les deux tables sont purgées au-delà
--     de la fenêtre d'observation par `ops/purge-metrics.sh`.
-- =====================================================================

CREATE TABLE search_events (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL,
  locale      locale_code NOT NULL,
  -- La recherche a-t-elle atterri sur une localité ou un immeuble connu ?
  -- C'est exactement la question que pose l'indicateur.
  resolved    boolean NOT NULL,
  -- Empreinte de la requête normalisée, jamais le texte. Elle ne sert qu'à
  -- ne pas compter dix fois la même recherche affinée filtre par filtre.
  query_hash  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Même raisonnement que `property_views.hour_bucket`, avec une fenêtre
  -- d'un jour : quelqu'un qui reprend « bkk1 » toute la matinée en changeant
  -- ses filtres fait UNE recherche, pas quinze. Le fuseau est fixé à UTC
  -- pour rendre l'expression immuable et indexable.
  day_bucket  date GENERATED ALWAYS AS
    ((created_at AT TIME ZONE 'UTC')::date) STORED
);

CREATE UNIQUE INDEX search_events_dedup
  ON search_events(session_id, query_hash, day_bucket);
CREATE INDEX search_events_recent_idx ON search_events(created_at DESC);
CREATE INDEX search_events_unresolved_idx
  ON search_events(created_at DESC) WHERE NOT resolved;

COMMENT ON TABLE search_events IS
  'Recherches en texte libre, dédoublonnées par session et par jour. Le '
  'dénominateur du taux de recherches sans résultat (§10).';

CREATE TABLE web_vitals (
  id          bigserial PRIMARY KEY,
  -- Une seule métrique aujourd'hui, mais la colonne évite d'avoir à migrer
  -- pour ajouter INP ou CLS : ce sont les mêmes conditions de collecte.
  metric      text NOT NULL,
  value_ms    integer NOT NULL,
  -- La cible du brief porte sur le MOBILE. Mélanger les deux facteurs de
  -- forme donnerait un p75 flatté par les postes de bureau.
  form_factor text NOT NULL,
  locale      locale_code NOT NULL,
  -- Le gabarit de page, pas l'URL : « fiche » ou « recherche » suffit à
  -- savoir où le problème se trouve, et ne trace personne.
  route       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_vitals_metric_known CHECK (metric IN ('lcp', 'inp', 'cls', 'ttfb')),
  CONSTRAINT web_vitals_form_factor CHECK (form_factor IN ('mobile', 'desktop')),
  -- Une mesure aberrante fausse un centile autant qu'une mesure manquante.
  CONSTRAINT web_vitals_plausible CHECK (value_ms >= 0 AND value_ms <= 120000)
);

CREATE INDEX web_vitals_percentile_idx
  ON web_vitals(metric, form_factor, created_at DESC);

COMMENT ON TABLE web_vitals IS
  'Mesures de terrain remontées par les navigateurs réels. Alimente le p75 '
  'mobile du LCP (§7, §10).';
