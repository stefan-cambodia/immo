-- =====================================================================
-- Alertes sur critères sauvegardés (phase 3 — acquisition).
--
-- Un visiteur qui cherche « condo 2 chambres à BKK1 sous 200 000 $ » et ne
-- trouve pas aujourd'hui doit pouvoir revenir sans y penser : le portail le
-- prévient quand un bien correspondant apparaît. C'est le levier de fidélité
-- le moins cher d'un portail, et celui qui alimente les leads des agences
-- (§8) avec des acheteurs déjà qualifiés par leurs propres critères.
--
-- Deux canaux, choisis pour ce marché : l'email, universel, et Telegram, le
-- canal où vivent déjà les agents et une bonne part des acheteurs (§6.1).
-- Pas de compte : une alerte est une adresse (ou un chat) et des critères.
-- =====================================================================

CREATE TYPE alert_channel   AS ENUM ('email', 'telegram');
CREATE TYPE alert_frequency AS ENUM ('instant', 'daily');

CREATE TABLE saved_searches (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel          alert_channel NOT NULL,
  email            text,
  telegram_chat_id bigint,
  locale           locale_code NOT NULL DEFAULT 'en',
  -- Les critères, dans la forme canonique produite par `canonicalFilters`
  -- (db/lib/alerts.mjs) : mêmes clés que `Filters` côté application, sans
  -- tri, pagination ni texte libre (résolu en quartier avant l'enregistrement).
  filters          jsonb NOT NULL,
  -- Résumé lisible figé à la création, dans la langue du visiteur : c'est ce
  -- qui apparaît en objet de mail et en tête de message.
  label            text NOT NULL,
  frequency        alert_frequency NOT NULL DEFAULT 'daily',
  -- Jeton de confirmation : double opt-in email, ou lien profond Telegram
  -- (`/start al_<jeton>`). À usage unique, stocké sous forme d'empreinte.
  confirm_token_hash text NOT NULL UNIQUE,
  -- Jeton de désabonnement : en clair, parce qu'il doit être réinséré dans
  -- chaque message envoyé, et que le pire qu'on puisse en faire est d'arrêter
  -- une alerte — rien à voir avec un jeton de session.
  manage_token     text NOT NULL UNIQUE,
  confirmed_at     timestamptz,
  unsubscribed_at  timestamptz,
  last_notified_at timestamptz,
  notified_count   integer NOT NULL DEFAULT 0,
  created_ip       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_searches_channel_target CHECK (
    (channel = 'email'    AND email IS NOT NULL) OR
    (channel = 'telegram')
  )
);
CREATE INDEX saved_searches_email_idx ON saved_searches(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX saved_searches_chat_idx  ON saved_searches(telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;
CREATE INDEX saved_searches_live_idx  ON saved_searches(frequency, last_notified_at)
  WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;
CREATE INDEX saved_searches_ip_idx    ON saved_searches(created_ip, created_at DESC);

CREATE TRIGGER saved_searches_touch
  BEFORE UPDATE ON saved_searches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Ce qui a déjà été envoyé : un bien n'est signalé qu'une fois par alerte,
-- même si une seconde agence le met en ligne ou si le prix bouge. La règle de
-- non-répétition est une clé primaire, pas une variable du job.
CREATE TABLE alert_deliveries (
  saved_search_id uuid NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saved_search_id, property_id)
);
CREATE INDEX alert_deliveries_property_idx ON alert_deliveries(property_id);

-- ---------------------------------------------------------------------
-- Le filtre, en un seul exemplaire.
--
-- La page de recherche construit son WHERE en TypeScript ; le job d'alerte
-- tourne en Node sans l'application. Plutôt que deux implémentations qui
-- dérivent, la sémantique des critères vit ici, et `npm run check:alerts`
-- vérifie que cette fonction et la page renvoient les mêmes biens.
--
-- `since` : ne retenir que les biens dont une annonce correspondante a été
-- créée après cet instant (NULL = tous). Une annonce reconfirmée n'est pas
-- nouvelle ; une annonce créée l'est, même si le bien existait déjà.
-- ---------------------------------------------------------------------
CREATE FUNCTION search_filter_matches(f jsonb, since timestamptz)
RETURNS TABLE (property_id uuid, first_listed_at timestamptz, price_min numeric)
LANGUAGE sql STABLE AS $$
  WITH tree AS (
    -- Descente récursive : « Phnom Penh » englobe tous ses khan et sangkat,
    -- exactement comme sur la page de recherche.
    WITH RECURSIVE t AS (
      SELECT id FROM locations WHERE slug = f->>'locationSlug'
      UNION ALL SELECT c.id FROM locations c JOIN t ON c.parent_id = t.id
    ) SELECT id FROM t
  ),
  types AS (SELECT jsonb_array_elements_text(coalesce(f->'types', '[]'::jsonb)) AS v),
  titles AS (SELECT jsonb_array_elements_text(coalesce(f->'titles', '[]'::jsonb)) AS v),
  amenities AS (
    SELECT coalesce(array_agg(v), '{}'::text[]) AS arr
    FROM jsonb_array_elements_text(coalesce(f->'amenities', '[]'::jsonb)) AS v
  ),
  poly AS (
    SELECT CASE
      WHEN jsonb_typeof(f->'polygon') = 'array' AND jsonb_array_length(f->'polygon') >= 3 THEN
        ST_SetSRID(ST_MakePolygon(ST_MakeLine(ARRAY(
          SELECT ST_MakePoint((c->>0)::float8, (c->>1)::float8)
          FROM jsonb_array_elements((f->'polygon') || jsonb_build_array(f->'polygon'->0))
                 WITH ORDINALITY AS e(c, n) ORDER BY n
        ))), 4326)
      ELSE NULL END AS geom
  ),
  box AS (
    SELECT CASE
      WHEN jsonb_typeof(f->'bbox') = 'array' AND jsonb_array_length(f->'bbox') = 4 THEN
        ST_MakeEnvelope((f->'bbox'->>0)::float8, (f->'bbox'->>1)::float8,
                        (f->'bbox'->>2)::float8, (f->'bbox'->>3)::float8, 4326)
      ELSE NULL END AS geom
  )
  SELECT p.id, min(l.created_at), min(l.price_usd)
  FROM properties p
  JOIN listings l ON l.property_id = p.id AND l.status = 'active'
  WHERE l.transaction_type = coalesce(f->>'transaction', 'sale')::transaction_type
    AND (f->>'priceMin' IS NULL OR l.price_usd >= (f->>'priceMin')::numeric)
    AND (f->>'priceMax' IS NULL OR l.price_usd <= (f->>'priceMax')::numeric)
    AND (since IS NULL OR l.created_at > since)
    AND (f->>'locationSlug' IS NULL OR p.location_id IN (SELECT id FROM tree))
    AND (f->>'buildingSlug' IS NULL
         OR p.building_id = (SELECT id FROM buildings WHERE slug = f->>'buildingSlug'))
    AND (NOT EXISTS (SELECT 1 FROM types) OR p.property_type::text IN (SELECT v FROM types))
    AND (f->>'bedsMin'  IS NULL OR p.bedrooms  >= (f->>'bedsMin')::int)
    AND (f->>'bathsMin' IS NULL OR p.bathrooms >= (f->>'bathsMin')::int)
    AND (f->>'areaMin'  IS NULL
         OR coalesce(p.indoor_area_sqm, p.land_area_sqm) >= (f->>'areaMin')::numeric)
    AND (f->>'floorMin' IS NULL OR p.floor >= (f->>'floorMin')::int)
    AND (NOT EXISTS (SELECT 1 FROM titles) OR p.title_type::text IN (SELECT v FROM titles))
    AND (NOT coalesce((f->>'foreignEligible')::boolean, false) OR p.foreign_eligible)
    AND (NOT coalesce((f->>'furnished')::boolean, false) OR p.furnished)
    AND p.amenities @> (SELECT arr FROM amenities)
    AND ((SELECT geom FROM box)  IS NULL OR p.geo_point && (SELECT geom FROM box))
    AND ((SELECT geom FROM poly) IS NULL OR ST_Within(p.geo_point, (SELECT geom FROM poly)))
  GROUP BY p.id
$$;

COMMENT ON FUNCTION search_filter_matches IS
  'Biens correspondant à des critères de recherche (forme canonique jsonb). '
  'Seule définition partagée entre les alertes et la vérification de parité '
  'avec la page de recherche.';

-- Hygiène : une alerte jamais confirmée ne doit pas rester indéfiniment.
CREATE FUNCTION purge_unconfirmed_alerts(older_than interval DEFAULT '7 days')
RETURNS integer LANGUAGE sql AS $$
  WITH x AS (
    DELETE FROM saved_searches
    WHERE confirmed_at IS NULL AND created_at < now() - older_than
    RETURNING 1
  ) SELECT count(*)::integer FROM x;
$$;
