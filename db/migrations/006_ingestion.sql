-- =====================================================================
-- Phase 2 — socle d'ingestion (§6.1, §6.2).
--
-- Les trois canaux (bot Telegram, flux XML/CSV, back-office) déposent la
-- même chose : une soumission. C'est le moteur de déduplication qui décide
-- ensuite où elle atterrit — bien existant, file de validation, ou nouveau
-- bien. Faire passer les trois canaux par le même entonnoir est ce qui
-- garantit qu'aucun ne peut contourner la règle du pin manuel.
-- =====================================================================

CREATE TYPE submission_status AS ENUM (
  'pending',       -- reçue, pas encore traitée
  'needs_pin',     -- tout est prêt sauf le pin : étape bloquante (principe n°2)
  'needs_review',  -- correspondance partielle : décision humaine (§6.2)
  'accepted',      -- rattachée à un bien, annonce créée
  'rejected',      -- écartée par un modérateur
  'failed'         -- payload inexploitable
);

CREATE TYPE dedup_decision AS ENUM ('merge', 'review', 'new');

CREATE TABLE submissions (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source        listing_source NOT NULL,
  -- Identifiant de l'annonce chez l'agence. C'est lui qui rend un flux
  -- rejouable : réimporter le même fichier ne crée pas de doublons.
  external_ref  text,
  agency_id     uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL,           -- brut, tel que reçu
  normalized    jsonb,                    -- champs typés après extraction
  status        submission_status NOT NULL DEFAULT 'pending',
  decision      dedup_decision,
  score         numeric(4,3),
  reasons       text[] NOT NULL DEFAULT '{}',
  property_id   uuid REFERENCES properties(id) ON DELETE SET NULL,
  listing_id    uuid REFERENCES listings(id) ON DELETE SET NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submissions_status_idx ON submissions(status, created_at DESC);
CREATE INDEX submissions_agency_idx ON submissions(agency_id, created_at DESC);
-- Idempotence des flux : une même annonce d'une même agence n'entre qu'une fois.
CREATE UNIQUE INDEX submissions_external_key
  ON submissions(agency_id, source, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TRIGGER submissions_touch
  BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION properties_set_signature();

-- ---------------------------------------------------------------------
-- Hash perceptuel réel (§6.2).
--
-- Le seed portait jusqu'ici une valeur textuelle simulée. Un dHash tient sur
-- 64 bits, et `bit_count(a # b)` donne la distance de Hamming directement en
-- SQL — c'est ce qui permet de chercher les images voisines, pas seulement
-- identiques. Les agences se repiquent les photos en les recompressant : une
-- égalité stricte ne les attraperait pas.
-- ---------------------------------------------------------------------
ALTER TABLE media DROP COLUMN perceptual_hash;
ALTER TABLE media ADD COLUMN phash bit(64);
CREATE INDEX media_phash_idx ON media(phash) WHERE phash IS NOT NULL;

-- Distance de Hamming entre deux empreintes. Immuable : utilisable en index
-- et dans les jointures du moteur de déduplication.
CREATE FUNCTION phash_distance(a bit(64), b bit(64)) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT bit_count(a # b)::integer;
$$;

COMMENT ON FUNCTION phash_distance IS
  'Distance de Hamming entre deux dHash. 0 = identique, <= 6 = très probablement '
  'la même photo recompressée ou recadrée, > 12 = images différentes.';
