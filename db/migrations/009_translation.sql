-- =====================================================================
-- Traduction automatique du contenu à l'ingestion (§4.1).
--
-- Le brief est précis sur le « quand » : les traductions sont générées à
-- l'ingestion, pas à l'affichage — « coût et latence ». Une fiche consultée
-- mille fois ne doit pas déclencher mille traductions.
--
-- `machine_translated` devient une colonne générée : l'état de traduction
-- n'existe plus qu'à un seul endroit, et la fiche publique continue de lire
-- le même champ qu'avant.
-- =====================================================================

CREATE TYPE translation_status AS ENUM (
  'not_needed',      -- pas de description à traduire
  'pending',         -- en attente de passage du worker
  'machine',         -- traduite par le modèle, marquée comme telle
  'human_reviewed',  -- relue par un humain (annonces premium, §4.1)
  'failed'           -- échec répété : la description reste dans sa langue source
);

ALTER TABLE listings DROP COLUMN machine_translated;

ALTER TABLE listings
  ADD COLUMN translation_status translation_status NOT NULL DEFAULT 'pending',
  ADD COLUMN translated_at timestamptz,
  ADD COLUMN translation_error text,
  -- Le marquage visuel de la fiche publique découle de l'état, il ne peut
  -- donc pas diverger de lui.
  ADD COLUMN machine_translated boolean
    GENERATED ALWAYS AS (translation_status = 'machine') STORED;

-- File de traduction : les annonces premium d'abord, elles seules partent
-- ensuite en relecture humaine.
CREATE INDEX listings_translation_queue_idx
  ON listings(translation_status, created_at)
  WHERE translation_status IN ('pending', 'failed');

CREATE INDEX listings_translation_review_idx
  ON listings(translated_at DESC)
  WHERE translation_status = 'machine';

COMMENT ON COLUMN listings.translation_status IS
  'Cycle de vie de la traduction (§4.1). La relecture humaine ne concerne que '
  'les annonces des agences premium ; les autres restent en machine.';
