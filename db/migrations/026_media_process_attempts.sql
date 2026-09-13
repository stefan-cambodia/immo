-- =====================================================================
-- Distinguer l'image morte de la panne passagère.
--
-- `process-media` marquait `processed_at` sur N'IMPORTE QUELLE erreur, au
-- motif — juste — qu'une image morte ne doit pas être retéléchargée à
-- chaque passage. Mais une erreur réseau n'est pas une image morte, et la
-- confusion coûte cher : au réveil d'une mise en veille, le service
-- repart avant que le Wi-Fi ne soit revenu, et comme rien ne ralentit un
-- échec immédiat, quatre fils en consomment des milliers par minute.
-- Mesuré ici : 1 881 médias brûlés dans la même minute, leurs empreintes
-- perdues pour de bon — et avec elles la corroboration photo dont la
-- déduplication a besoin (§6.2).
--
-- D'où un compteur de tentatives. Une panne passagère ne consomme plus le
-- média : elle incrémente. Ce qui échoue obstinément finit tout de même
-- par sortir de la file, sans quoi une image réellement morte la
-- bloquerait en tête à chaque passage.
-- =====================================================================

ALTER TABLE media ADD COLUMN process_attempts integer NOT NULL DEFAULT 0;

-- La file se sert des moins tentés d'abord : un média qui échoue en boucle
-- ne doit pas retarder ceux qui n'ont jamais été essayés. L'index de la
-- file est refait sur ce nouvel ordre.
DROP INDEX media_pending_idx;
CREATE INDEX media_pending_idx ON media(process_attempts, created_at)
  WHERE processed_at IS NULL;
