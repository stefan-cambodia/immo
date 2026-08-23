-- La relecture d'une traduction est une action de modération : elle retire le
-- marqueur « traduction automatique » d'une fiche publique, et engage donc le
-- portail sur le contenu.
ALTER TYPE audit_action ADD VALUE 'translation_reviewed';
