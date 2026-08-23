-- =====================================================================
-- Fonction de purge. Séparée de 004 parce qu'une valeur d'énumération
-- fraîchement ajoutée ne peut pas être utilisée dans la transaction qui
-- l'a ajoutée.
-- =====================================================================

CREATE FUNCTION purge_audit_log(
  p_ids            bigint[],
  p_cutoff         timestamptz,
  p_actor_email    text,
  p_archive_name   text,
  p_archive_sha256 text,
  p_retention_days integer
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_deleted bigint;
  v_oldest  timestamptz;
  v_newest  timestamptz;
  v_bad     bigint;
BEGIN
  -- Pas d'archive, pas de purge.
  IF p_archive_name IS NULL OR p_archive_sha256 IS NULL
     OR length(p_archive_sha256) <> 64 THEN
    RAISE EXCEPTION 'purge refusée : archive et empreinte SHA-256 obligatoires';
  END IF;

  -- Les identifiants fournis doivent tous être hors rétention, et aucun ne
  -- doit être une entrée de purge : la fonction ne fait pas confiance à son
  -- appelant sur ce point.
  SELECT count(*) INTO v_bad FROM audit_log
   WHERE id = ANY(p_ids)
     AND (created_at >= p_cutoff OR action = 'audit_purged');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'purge refusée : % entrée(s) hors périmètre autorisé', v_bad;
  END IF;

  SELECT min(created_at), max(created_at) INTO v_oldest, v_newest
    FROM audit_log WHERE id = ANY(p_ids);

  -- Drapeau local à la transaction : il retombe au COMMIT comme au ROLLBACK.
  PERFORM set_config('audit.purge', 'on', true);

  WITH gone AS (DELETE FROM audit_log WHERE id = ANY(p_ids) RETURNING 1)
  SELECT count(*) INTO v_deleted FROM gone;

  PERFORM set_config('audit.purge', 'off', true);

  -- La purge se journalise elle-même, dans la même transaction que la
  -- suppression qu'elle décrit.
  INSERT INTO audit_log(actor_email, actor_role, action, target_type,
                        target_label, details)
  VALUES (p_actor_email, 'admin', 'audit_purged', 'audit_log',
          p_archive_name,
          jsonb_build_object(
            'purged', v_deleted,
            'oldest', v_oldest,
            'newest', v_newest,
            'cutoff', p_cutoff,
            'retentionDays', p_retention_days,
            'archive', p_archive_name,
            'sha256', p_archive_sha256));

  RETURN v_deleted;
END $$;

COMMENT ON FUNCTION purge_audit_log IS
  'Unique voie de suppression dans audit_log. Exige une archive vérifiée, '
  'refuse les entrées encore sous rétention et les entrées audit_purged, '
  'et journalise sa propre exécution.';
