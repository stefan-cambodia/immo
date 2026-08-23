-- =====================================================================
-- Bot Telegram (§6.1, canal 1 — « canal déterminant du volume »).
--
-- L'agent travaille depuis son téléphone, dans une conversation. L'état de
-- cette conversation doit survivre au redémarrage du worker : un agent qui a
-- envoyé ses photos et se fait couper au moment du pin ne doit pas tout
-- recommencer.
-- =====================================================================

CREATE TYPE bot_state AS ENUM (
  'idle',          -- rien en cours
  'collecting',    -- photos et texte reçus, en attente de complément
  'confirming',    -- fiche extraite proposée, en attente de validation
  'awaiting_pin'   -- validée, en attente du partage de position
);

CREATE TABLE bot_sessions (
  chat_id     bigint PRIMARY KEY,
  agent_id    uuid REFERENCES agents(id) ON DELETE SET NULL,
  state       bot_state NOT NULL DEFAULT 'idle',
  -- Brouillon de la fiche en cours : texte reçu, photos, champs extraits.
  draft       jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_update_id bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER bot_sessions_touch
  BEFORE UPDATE ON bot_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Décalage de lecture des mises à jour Telegram. Une seule ligne : le worker
-- reprend là où il s'est arrêté au lieu de rejouer l'historique.
CREATE TABLE bot_offset (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  update_id  bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bot_offset(id, update_id) VALUES (true, 0);

-- Relances J-7 déjà envoyées, pour ne pas harceler l'agent (§6.3).
CREATE TABLE listing_reminders (
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  channel    text NOT NULL DEFAULT 'telegram',
  PRIMARY KEY (listing_id, sent_at)
);
CREATE INDEX listing_reminders_recent_idx ON listing_reminders(listing_id, sent_at DESC);
