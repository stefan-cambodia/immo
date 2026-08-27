-- =====================================================================
-- Rotation du rattrapage de déduplication (§6.2).
--
-- ops/rescan-duplicates.sh tourne toutes les heures et repasse par le
-- moteur les biens dont les photos sont hachées, par lots de 5 000. Il les
-- prenait dans l'ordre de création : au-delà de 5 000 biens hachés, les plus
-- récents — ceux-là mêmes dont les empreintes viennent d'être calculées —
-- n'auraient jamais été réévalués. Un lot qui ne tourne pas n'est pas un
-- lot, c'est un plafond.
--
-- La colonne retient la date du dernier passage. Le job prend d'abord les
-- biens jamais réévalués, puis les plus anciens passages : chaque bien
-- revient dans le lot à son tour, quelle que soit la taille de la base.
--
-- (Au passage : l'en-tête de 020_portal_import.sql disait que les
-- photographies du portail n'étaient pas téléchargées. Ce n'est plus vrai
-- depuis que la démo tourne sur les vraies annonces : elles le sont, et
-- leurs empreintes sont précisément ce que ce rattrapage attend.)
-- =====================================================================

ALTER TABLE properties ADD COLUMN dedup_rescanned_at timestamptz;

COMMENT ON COLUMN properties.dedup_rescanned_at IS
  'Dernier passage du rattrapage de déduplication (db/jobs/rescan-duplicates.mjs). '
  'NULL : jamais réévalué — servi en premier.';

CREATE INDEX properties_dedup_rescan_idx
  ON properties (dedup_rescanned_at NULLS FIRST, created_at);
