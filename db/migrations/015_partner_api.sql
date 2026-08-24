-- =====================================================================
-- Ouverture d'une API pour partenaires (phase 4).
--
-- Le portail distribue sa donnée dédupliquée — sa valeur centrale — à des
-- partenaires nommés : banques, promoteurs, proptech, cabinets. L'API est
-- en LECTURE SEULE : la saisie reste sur les canaux d'ingestion (§6.1),
-- qui portent le pin manuel et la déduplication. Ouvrir l'écriture ici
-- contournerait les deux règles verrouillées.
--
-- Trois décisions structurantes :
--
-- 1. La clé n'est stockée que HACHÉE (SHA-256), comme un mot de passe :
--    elle est affichée une seule fois à l'émission. Seul un préfixe en
--    clair subsiste pour que la modération identifie une clé sans pouvoir
--    la rejouer. Une clé compromise se révoque, elle ne se « change » pas.
--
-- 2. Le quota est JOURNALIER et compté en base — une ligne par clé et par
--    jour. Pas de dépendance Redis pour un comptage dont la précision à
--    la milliseconde n'apporte rien ; et le compteur devient de lui-même
--    la statistique d'usage qui permettra de facturer l'API plus tard.
--
-- 3. L'API sert des fiches Property agrégées, jamais un Listing isolé
--    (§3.3), et ne transporte AUCUNE coordonnée d'agent : le contact est
--    l'événement facturable du portail (§8), il ne sort pas en gros.
-- =====================================================================

-- ----------------------------------------------------------- Partenaires
CREATE TABLE api_partners (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  contact    text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ Clés
-- Plusieurs clés par partenaire : une par intégration, révocables une à
-- une sans couper les autres.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id   uuid NOT NULL REFERENCES api_partners(id) ON DELETE CASCADE,
  key_prefix   text NOT NULL,          -- identification humaine, jamais suffisant pour appeler
  key_hash     text NOT NULL UNIQUE,   -- SHA-256 hex de la clé complète
  label        text NOT NULL DEFAULT '',
  daily_quota  integer NOT NULL DEFAULT 5000 CHECK (daily_quota > 0),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_partner_idx ON api_keys(partner_id, created_at DESC);

-- ------------------------------------------------------ Compteur d'usage
CREATE TABLE api_usage (
  key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day    date NOT NULL DEFAULT current_date,
  count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

-- Consomme une unité de quota pour la clé et renvoie le solde restant
-- (négatif au-delà du quota : la requête est alors refusée, mais reste
-- comptée — un client qui martèle au-delà de son quota doit se voir).
CREATE FUNCTION api_consume(p_key_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_quota integer;
  v_count integer;
BEGIN
  SELECT daily_quota INTO v_quota FROM api_keys WHERE id = p_key_id;
  IF v_quota IS NULL THEN RETURN NULL; END IF;
  INSERT INTO api_usage(key_id, day, count) VALUES (p_key_id, current_date, 1)
  ON CONFLICT (key_id, day) DO UPDATE SET count = api_usage.count + 1
  RETURNING count INTO v_count;
  UPDATE api_keys SET last_used_at = now() WHERE id = p_key_id;
  RETURN v_quota - v_count;
END $$;

-- ------------------------------------------------------ Journal d'audit
-- Émettre ou révoquer une clé ouvre ou ferme un accès à toute la base
-- publique : ces gestes sont journalisés comme ceux qui engagent l'argent.
ALTER TYPE audit_action ADD VALUE 'api_partner_created';
ALTER TYPE audit_action ADD VALUE 'api_key_issued';
ALTER TYPE audit_action ADD VALUE 'api_key_revoked';

ALTER TYPE audit_target ADD VALUE 'api_partner';
ALTER TYPE audit_target ADD VALUE 'api_key';
