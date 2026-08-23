-- =====================================================================
-- Journal d'audit des actions de modération.
--
-- Deux exigences dictent la forme de cette table :
--
-- 1. Une entrée est écrite dans la MÊME transaction que la mutation qu'elle
--    décrit. Un journal écrit après coup, au mieux, n'est pas un journal
--    d'audit : la fusion réussie dont la trace a échoué est exactement le cas
--    qu'on cherche à couvrir.
-- 2. Une entrée est immuable. Les colonnes `actor_*` et `target_label` sont
--    des instantanés dénormalisés : si le compte est supprimé ou le bien
--    fusionné, on doit encore savoir qui a fait quoi, sur quoi.
-- =====================================================================

CREATE TYPE audit_action AS ENUM (
  'sign_in',
  'sign_out',
  'property_created',
  'listing_confirmed',
  'dedup_merged',
  'dedup_distinct',
  'alias_added'
);

CREATE TYPE audit_target AS ENUM (
  'session', 'property', 'listing', 'location', 'dedup_candidate'
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  -- L'auteur est conservé par référence ET par instantané : la référence sert
  -- aux jointures tant que le compte existe, l'instantané survit à sa
  -- suppression.
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email   text NOT NULL,
  actor_role    user_role NOT NULL,
  actor_agency  text,
  action        audit_action NOT NULL,
  target_type   audit_target NOT NULL,
  target_id     text,
  target_label  text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_recent_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log(actor_email, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log(action, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log(target_type, target_id);

-- Le journal est en ajout seul. Une entrée corrigeable après coup ne prouve
-- rien ; la contrainte est posée dans la base plutôt que confiée à la
-- discipline du code applicatif.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est en ajout seul : % interdit', TG_OP;
END $$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
