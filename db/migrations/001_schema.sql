-- =====================================================================
-- Portail immobilier Cambodge — schéma initial (§3 du brief)
-- Principe verrouillé n°1 : séparation stricte Property / Listing.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- Énumérations (§5.1)
-- ---------------------------------------------------------------------
CREATE TYPE location_level    AS ENUM ('province', 'district', 'commune', 'neighborhood');
CREATE TYPE property_type     AS ENUM ('condo', 'borey_house', 'villa', 'flat_shophouse',
                                       'land', 'commercial', 'warehouse', 'whole_building');
CREATE TYPE villa_subtype     AS ENUM ('twin', 'link', 'queen', 'king');
CREATE TYPE title_type        AS ENUM ('hard', 'soft', 'strata', 'unknown');
CREATE TYPE transaction_type  AS ENUM ('sale', 'rent');
CREATE TYPE price_period      AS ENUM ('total', 'monthly');
CREATE TYPE listing_status    AS ENUM ('active', 'pending', 'expired', 'sold', 'rejected');
CREATE TYPE listing_source    AS ENUM ('telegram_bot', 'xml_feed', 'csv', 'backoffice');
CREATE TYPE verification_status AS ENUM ('unverified', 'documents_received', 'verified');
CREATE TYPE subscription_tier AS ENUM ('free', 'standard', 'premium');
CREATE TYPE building_status   AS ENUM ('planned', 'under_construction', 'completed');
CREATE TYPE lead_channel      AS ENUM ('phone', 'telegram', 'whatsapp', 'wechat', 'form', 'email');
CREATE TYPE lead_action       AS ENUM ('reveal_phone', 'call', 'message', 'form_submit', 'save');
CREATE TYPE locale_code       AS ENUM ('fr', 'en', 'zh', 'km');

-- ---------------------------------------------------------------------
-- Location : hiérarchie administrative + alias de romanisation (§5.2)
-- ---------------------------------------------------------------------
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id   uuid REFERENCES locations(id) ON DELETE CASCADE,
  level       location_level NOT NULL,
  slug        text NOT NULL UNIQUE,
  name_i18n   jsonb NOT NULL,              -- { fr, en, zh, km }
  aliases     text[] NOT NULL DEFAULT '{}', -- CRITIQUE : sans lui ~1/3 des recherches échouent
  boundary    geometry(Polygon, 4326),
  geo_center  geometry(Point, 4326) NOT NULL,
  listing_count integer NOT NULL DEFAULT 0, -- dénormalisé, rafraîchi par trigger
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX locations_parent_idx  ON locations(parent_id);
CREATE INDEX locations_level_idx   ON locations(level);
CREATE INDEX locations_center_idx  ON locations USING gist(geo_center);
CREATE INDEX locations_aliases_idx ON locations USING gin(aliases);

-- ---------------------------------------------------------------------
-- Promoteurs et immeubles / boreys nommés
-- ---------------------------------------------------------------------
CREATE TABLE developers (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  country    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE buildings (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            text NOT NULL UNIQUE,
  name_i18n       jsonb NOT NULL,
  developer_id    uuid REFERENCES developers(id) ON DELETE SET NULL,
  location_id     uuid NOT NULL REFERENCES locations(id),
  geo_point       geometry(Point, 4326) NOT NULL,  -- posé à la main (principe n°2)
  total_floors    integer,
  total_units     integer,
  completion_year integer,
  status          building_status NOT NULL DEFAULT 'completed',
  amenities       text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX buildings_location_idx ON buildings(location_id);
CREATE INDEX buildings_geo_idx      ON buildings USING gist(geo_point);

-- ---------------------------------------------------------------------
-- Agences et agents
-- ---------------------------------------------------------------------
CREATE TABLE agencies (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug                text NOT NULL UNIQUE,
  name                text NOT NULL,
  logo_url            text,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  subscription_tier   subscription_tier   NOT NULL DEFAULT 'free',
  listing_quota       integer NOT NULL DEFAULT 20,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id    uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  phone        text NOT NULL,
  telegram     text,
  wechat       text,
  spoken_langs locale_code[] NOT NULL DEFAULT '{en}',
  telegram_chat_id bigint,           -- pour la relance J-7 (§6.3)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_agency_idx ON agents(agency_id);

-- ---------------------------------------------------------------------
-- Property : le bien physique
-- ---------------------------------------------------------------------
CREATE TABLE properties (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference         text NOT NULL UNIQUE,       -- identifiant public court, ex. PP-4F2A19
  building_id       uuid REFERENCES buildings(id) ON DELETE SET NULL,
  property_type     property_type NOT NULL,
  villa_sub         villa_subtype,
  location_id       uuid NOT NULL REFERENCES locations(id),
  geo_point         geometry(Point, 4326) NOT NULL, -- JAMAIS géocodé (principe n°2)
  geo_pin_by        text,                       -- qui a posé le pin : traçabilité
  geo_pin_at        timestamptz,
  floor             integer,
  unit_number       text,
  bedrooms          integer NOT NULL DEFAULT 0,
  bathrooms         integer NOT NULL DEFAULT 0,
  indoor_area_sqm   numeric(10,2),
  land_area_sqm     numeric(10,2),
  title_type        title_type NOT NULL DEFAULT 'unknown',
  -- §5.3 : un étranger ne peut posséder ni terrain ni rez-de-chaussée.
  foreign_eligible  boolean GENERATED ALWAYS AS
                      (title_type = 'strata' AND COALESCE(floor, 0) >= 1) STORED,
  year_built        integer,
  furnished         boolean NOT NULL DEFAULT false,
  amenities         text[] NOT NULL DEFAULT '{}',
  dedup_signature   text NOT NULL,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT properties_pin_required CHECK (geo_point IS NOT NULL)
);
CREATE INDEX properties_geo_idx       ON properties USING gist(geo_point);
CREATE INDEX properties_location_idx  ON properties(location_id);
CREATE INDEX properties_building_idx  ON properties(building_id);
CREATE INDEX properties_type_idx      ON properties(property_type);
CREATE INDEX properties_foreign_idx   ON properties(foreign_eligible) WHERE foreign_eligible;
CREATE INDEX properties_dedup_idx     ON properties(dedup_signature);

-- ---------------------------------------------------------------------
-- Listing : l'annonce d'une agence sur un bien
-- ---------------------------------------------------------------------
CREATE TABLE listings (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  agency_id               uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  agent_id                uuid NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
  transaction_type        transaction_type NOT NULL,
  price_usd               numeric(12,2) NOT NULL,
  price_period            price_period NOT NULL DEFAULT 'total',
  negotiable              boolean NOT NULL DEFAULT true,
  status                  listing_status NOT NULL DEFAULT 'active',
  source                  listing_source NOT NULL DEFAULT 'backoffice',
  featured                boolean NOT NULL DEFAULT false,   -- mise en avant payante (§8)
  expires_at              timestamptz NOT NULL DEFAULT now() + interval '45 days',
  last_confirmed_at       timestamptz NOT NULL DEFAULT now(),
  description_i18n        jsonb NOT NULL DEFAULT '{}'::jsonb,
  description_source_lang locale_code NOT NULL DEFAULT 'en',
  machine_translated      boolean NOT NULL DEFAULT true,    -- marquage visuel (§4.1)
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listings_price_positive CHECK (price_usd > 0),
  CONSTRAINT listings_rent_is_monthly CHECK
    (transaction_type <> 'rent' OR price_period = 'monthly')
);
CREATE INDEX listings_property_idx ON listings(property_id);
CREATE INDEX listings_agency_idx   ON listings(agency_id);
CREATE INDEX listings_active_idx   ON listings(status, transaction_type, price_usd)
  WHERE status = 'active';
CREATE INDEX listings_expiry_idx   ON listings(expires_at) WHERE status = 'active';
-- Une agence ne publie qu'une annonce active par bien et par type de transaction.
CREATE UNIQUE INDEX listings_unique_active ON listings(property_id, agency_id, transaction_type)
  WHERE status = 'active';

CREATE TABLE price_history (
  id          bigserial PRIMARY KEY,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price_usd   numeric(12,2) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_listing_idx ON price_history(listing_id, recorded_at DESC);

-- ---------------------------------------------------------------------
-- Média : hash perceptuel pour la détection de réutilisation (§6.2)
-- ---------------------------------------------------------------------
CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id     uuid REFERENCES properties(id) ON DELETE CASCADE,
  listing_id      uuid REFERENCES listings(id)   ON DELETE CASCADE,
  url             text NOT NULL,
  position        integer NOT NULL DEFAULT 0,
  width           integer,
  height          integer,
  perceptual_hash text,
  variants        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_owner CHECK (property_id IS NOT NULL OR listing_id IS NOT NULL)
);
CREATE INDEX media_property_idx ON media(property_id, position);
CREATE INDEX media_phash_idx    ON media(perceptual_hash);

-- ---------------------------------------------------------------------
-- Lead : indispensable dès la v1 pour facturer et prouver la valeur (§8)
-- ---------------------------------------------------------------------
CREATE TABLE leads (
  id          bigserial PRIMARY KEY,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  agency_id   uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel     lead_channel NOT NULL,
  action_type lead_action  NOT NULL,
  locale      locale_code  NOT NULL,
  session_id  text,
  referrer    text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_agency_idx  ON leads(agency_id, created_at DESC);
CREATE INDEX leads_listing_idx ON leads(listing_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Recherches sans résultat : alimente la table d'alias (§10)
-- ---------------------------------------------------------------------
CREATE TABLE search_misses (
  id         bigserial PRIMARY KEY,
  query      text NOT NULL,
  locale     locale_code NOT NULL,
  filters    jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved   boolean NOT NULL DEFAULT false, -- traité manuellement chaque semaine
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_misses_open_idx ON search_misses(created_at DESC) WHERE NOT resolved;

-- ---------------------------------------------------------------------
-- File de validation de déduplication (§6.2) — jamais de fusion auto
-- sur correspondance partielle.
-- ---------------------------------------------------------------------
CREATE TABLE dedup_candidates (
  id            bigserial PRIMARY KEY,
  property_a_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  property_b_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  score         numeric(4,3) NOT NULL,
  reasons       text[] NOT NULL DEFAULT '{}',
  reviewed_at   timestamptz,
  decision      text,   -- merged | distinct | null (en attente)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dedup_pair_order CHECK (property_a_id < property_b_id),
  UNIQUE (property_a_id, property_b_id)
);
CREATE INDEX dedup_pending_idx ON dedup_candidates(created_at) WHERE reviewed_at IS NULL;

-- ---------------------------------------------------------------------
-- Vue d'agrégation : « 5 agences proposent ce bien, de 145 000 $ à 162 000 $ » (§3.3)
-- ---------------------------------------------------------------------
CREATE VIEW property_offers AS
SELECT
  p.id                                   AS property_id,
  l.transaction_type,
  count(*)                               AS listing_count,
  count(DISTINCT l.agency_id)            AS agency_count,
  min(l.price_usd)                       AS price_min,
  max(l.price_usd)                       AS price_max,
  max(l.last_confirmed_at)               AS last_confirmed_at,
  bool_or(l.featured)                    AS featured
FROM properties p
JOIN listings l ON l.property_id = p.id AND l.status = 'active'
GROUP BY p.id, l.transaction_type;

-- ---------------------------------------------------------------------
-- Fonctions utilitaires
-- ---------------------------------------------------------------------

-- Signature de déduplication composite (§6.2).
CREATE FUNCTION dedup_signature(
  p_building_id uuid, p_floor integer, p_area numeric, p_bedrooms integer,
  p_location_id uuid, p_type property_type
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_building_id IS NOT NULL THEN
      concat_ws(':', 'b', p_building_id::text, coalesce(p_floor, -1)::text,
                round(coalesce(p_area, 0))::text, coalesce(p_bedrooms, 0)::text)
    ELSE
      concat_ws(':', 'l', p_location_id::text, p_type::text,
                round(coalesce(p_area, 0) / 5) * 5, coalesce(p_bedrooms, 0)::text)
  END;
$$;

CREATE FUNCTION properties_set_signature() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.dedup_signature := dedup_signature(NEW.building_id, NEW.floor, NEW.indoor_area_sqm,
                                         NEW.bedrooms, NEW.location_id, NEW.property_type);
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER properties_signature_trg
  BEFORE INSERT OR UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_set_signature();

-- Historisation automatique des prix (§6.3).
CREATE FUNCTION listings_track_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.price_usd IS DISTINCT FROM OLD.price_usd THEN
    INSERT INTO price_history(listing_id, price_usd) VALUES (NEW.id, NEW.price_usd);
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER listings_price_trg
  AFTER INSERT ON listings
  FOR EACH ROW EXECUTE FUNCTION listings_track_price();

CREATE TRIGGER listings_price_upd_trg
  BEFORE UPDATE OF price_usd ON listings
  FOR EACH ROW EXECUTE FUNCTION listings_track_price();

-- Expiration à 45 jours (§6.3) — appelée par un cron / worker.
CREATE FUNCTION expire_stale_listings() RETURNS integer LANGUAGE sql AS $$
  WITH x AS (
    UPDATE listings SET status = 'expired', updated_at = now()
    WHERE status = 'active' AND expires_at < now()
    RETURNING 1
  ) SELECT count(*)::integer FROM x;
$$;
