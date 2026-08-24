-- =====================================================================
-- Gestion des comptes (écart de mise en production).
--
-- Jusqu'ici les comptes n'existaient qu'au seed : ni création en
-- fonctionnement, ni réinitialisation de mot de passe. Ici, deux
-- circuits sur un même mécanisme de jeton à usage unique :
--
--   invitation      — la modération crée le compte, la personne invitée
--                     choisit son mot de passe (7 jours pour le faire) ;
--   réinitialisation — la personne demande un lien par email (1 heure).
--
-- Trois décisions structurantes :
--
-- 1. Pas d'inscription libre. Un compte du back-office engage une agence
--    et ses annonces : il se crée en modération, comme le badge de
--    vérification. L'invitation remplace le mot de passe provisoire —
--    aucun secret ne transite par la modération ni par Telegram.
--
-- 2. Le jeton est stocké haché (SHA-256), comme les sessions et les clés
--    API : une fuite de la base ne permet ni d'usurper une session, ni
--    d'appeler l'API, ni de prendre un compte.
--
-- 3. Les demandes de réinitialisation sont journalisées dans leur propre
--    table — même pour une adresse inconnue. C'est l'assiette de la
--    limitation (3/heure par adresse, 12/heure par IP) et la trace d'une
--    campagne d'énumération ; le journal d'audit, lui, ne trace que des
--    actions sur des comptes réels.
-- =====================================================================

CREATE TYPE account_token_purpose AS ENUM ('invite', 'reset');

CREATE TABLE account_tokens (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    account_token_purpose NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  -- Qui a invité, pour l'affichage en modération ; null pour un reset.
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON account_tokens(user_id, purpose, created_at DESC);

-- Demandes de réinitialisation, y compris pour des adresses inconnues :
-- la réponse de la page est la même dans les deux cas (pas d'énumération),
-- la table garde la différence.
CREATE TABLE password_reset_requests (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  ip         text,
  known      boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_requests_email_idx
  ON password_reset_requests(email, created_at DESC);
CREATE INDEX password_reset_requests_ip_idx
  ON password_reset_requests(ip, created_at DESC);

-- ------------------------------------------------------ Journal d'audit
-- Créer, inviter, activer/désactiver un compte sont des décisions de
-- modération ; la pose d'un mot de passe est l'événement de sécurité qui
-- clôt un circuit. Les demandes de reset restent hors du journal : leur
-- volume (et les adresses inconnues) vivent dans la table ci-dessus.
ALTER TYPE audit_action ADD VALUE 'account_created';
ALTER TYPE audit_action ADD VALUE 'account_invited';
ALTER TYPE audit_action ADD VALUE 'account_status_changed';
ALTER TYPE audit_action ADD VALUE 'password_set';

ALTER TYPE audit_target ADD VALUE 'user';
