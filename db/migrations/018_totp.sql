-- =====================================================================
-- Second facteur TOTP (écart de mise en production).
--
-- Le back-office est exposé sur Internet et « les mots de passe d'agences
-- seront faibles » (002_auth) : les comptes — la modération en premier —
-- peuvent poser un second facteur TOTP standard (RFC 6238, 6 chiffres,
-- 30 s), celui des applications d'authentification courantes.
--
-- Trois décisions structurantes :
--
-- 1. AUTO-ENRÔLEMENT UNIQUEMENT. La modération crée des comptes mais ne
--    voit jamais un secret TOTP : chacun enrôle son propre téléphone et
--    confirme par un premier code. Un secret que quelqu'un d'autre a pu
--    voir ne protège rien.
--
-- 2. Un code ne sert qu'une fois : `totp_last_step` retient le dernier pas
--    accepté et tout pas antérieur ou égal est refusé. Sans cela un code
--    intercepté resterait valable trente secondes.
--
-- 3. L'étape intermédiaire de connexion (mot de passe validé, code
--    attendu) est un jeton de compte comme les autres — même table, même
--    hachage, 5 minutes — pas un état de session à moitié créé.
-- =====================================================================

ALTER TABLE users ADD COLUMN totp_secret text;
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;

-- Le secret existe dès le début de l'enrôlement, mais le second facteur ne
-- s'applique qu'une fois confirmé : `totp_enabled_at` est l'interrupteur.

ALTER TYPE account_token_purpose ADD VALUE 'second_factor';

ALTER TYPE audit_action ADD VALUE 'totp_enabled';
ALTER TYPE audit_action ADD VALUE 'totp_disabled';
