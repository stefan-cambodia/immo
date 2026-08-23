-- =====================================================================
-- Mesure d'audience par bien (phase 3 — tableau de bord agence).
--
-- Le portail vend des abonnements aux agences : il doit pouvoir montrer ce
-- qu'elles obtiennent. Les leads sont tracés depuis la v1 (§8) ; il manquait
-- le dénominateur — combien de personnes ont vu la fiche pour qu'un contact
-- se produise.
--
-- Une vue porte sur un BIEN, pas sur une annonce : plusieurs agences peuvent
-- proposer le même bien, et elles bénéficient toutes de la même page.
-- L'attribution à l'agence se fait à la lecture, via ses annonces actives.
-- =====================================================================

CREATE TABLE property_views (
  id          bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  session_id  text NOT NULL,
  locale      locale_code NOT NULL,
  -- Hôte du référent seulement, jamais l'URL complète, et aucune adresse IP :
  -- ce qui est utile à une agence, c'est « depuis Google » ou « depuis
  -- Facebook », pas le parcours nominatif d'un visiteur.
  referrer_host text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Fenêtre de dédoublonnage : un visiteur qui recharge la fiche dix fois
  -- dans l'heure ne vaut pas dix vues. Sans cela, le chiffre vendu aux
  -- agences serait faux dans le sens qui les arrange, ce qui est pire que
  -- pas de chiffre du tout.
  -- `date_trunc` sur un timestamptz dépend du fuseau de la session et n'est
  -- donc pas immuable : le fuseau est fixé à UTC pour que l'expression le
  -- devienne et puisse porter un index.
  hour_bucket timestamp GENERATED ALWAYS AS
    (date_trunc('hour', created_at AT TIME ZONE 'UTC')) STORED
);

CREATE UNIQUE INDEX property_views_dedup
  ON property_views(property_id, session_id, hour_bucket);
CREATE INDEX property_views_property_idx ON property_views(property_id, created_at DESC);
CREATE INDEX property_views_recent_idx ON property_views(created_at DESC);

COMMENT ON TABLE property_views IS
  'Vues de fiches, dédoublonnées par session et par heure. Le dénominateur du '
  'taux de contact affiché aux agences.';
