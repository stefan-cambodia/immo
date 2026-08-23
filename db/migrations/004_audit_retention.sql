-- =====================================================================
-- Rétention et export du journal d'audit.
--
-- Purger un journal en ajout seul est une contradiction apparente. Elle se
-- résout en rendant la purge elle-même auditable et étroitement encadrée :
--
--   * la suppression n'est possible qu'à travers `purge_audit_log()`, qui
--     lève un drapeau local à la transaction ; un DELETE ordinaire reste
--     refusé ;
--   * aucune purge sans archive : la fonction exige le nom et l'empreinte
--     SHA-256 du fichier d'archive, et refuse sans eux ;
--   * la purge écrit sa propre entrée, qui n'est elle-même jamais purgeable.
--     C'est cette chaîne d'entrées `audit_purged` qui atteste la continuité
--     du journal malgré les trous.
-- =====================================================================

ALTER TYPE audit_action ADD VALUE 'audit_exported';
ALTER TYPE audit_action ADD VALUE 'audit_purged';
ALTER TYPE audit_target ADD VALUE 'audit_log';

-- La règle d'immuabilité devient : UPDATE toujours interdit, DELETE interdit
-- sauf sous le drapeau posé par la fonction de purge.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('audit.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log est en ajout seul : % interdit', TG_OP;
END $$;
