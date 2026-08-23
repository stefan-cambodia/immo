-- =====================================================================
-- Authentification du back-office.
--
-- Sessions côté serveur plutôt que jetons signés : elles sont révocables
-- immédiatement (agent qui quitte une agence, poste compromis), ce qui
-- compte davantage ici que d'économiser une requête. La base est déjà là.
-- =====================================================================

CREATE TYPE user_role AS ENUM ('admin', 'agency');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'agency',
  agency_id     uuid REFERENCES agencies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Un compte « agency » est toujours rattaché à une agence ; un compte
  -- « admin » ne l'est jamais. La règle d'autorisation ne peut pas dériver.
  CONSTRAINT users_agency_scope CHECK (
    (role = 'agency' AND agency_id IS NOT NULL) OR
    (role = 'admin'  AND agency_id IS NULL)
  )
);

-- L'adresse est normalisée en minuscules à l'écriture : l'unicité doit porter
-- sur la forme normalisée, sans quoi deux comptes « A@x.kh » et « a@x.kh »
-- coexisteraient.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  -- On ne stocke jamais le jeton lui-même : une fuite de la base ne permet
  -- pas d'usurper une session en cours.
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip         text,
  user_agent text
);
CREATE INDEX sessions_user_idx   ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

-- Limitation des tentatives : le back-office est exposé sur Internet et les
-- mots de passe d'agences seront faibles.
CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  ip         text,
  successful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_recent_idx ON login_attempts(email, created_at DESC);
CREATE INDEX login_attempts_ip_idx     ON login_attempts(ip, created_at DESC);

CREATE FUNCTION purge_expired_sessions() RETURNS integer LANGUAGE sql AS $$
  WITH x AS (DELETE FROM sessions WHERE expires_at < now() RETURNING 1)
  SELECT count(*)::integer FROM x;
$$;
