-- =====================================================================
-- Pipeline des médias (écart de mise en production — §7).
--
-- Le budget de performance impose « images en WebP/AVIF, plusieurs
-- tailles ». Jusqu'ici les fiches servaient l'URL source telle quelle :
-- `variants` restait vide. Un job hors application (comme l'expiration
-- et les alertes) traite chaque média une fois : variantes générées,
-- stockées sur la couche de stockage abstraite (locale ou S3), et l'URL
-- source cesse d'être un point de fragilité — une photo Telegram expire,
-- nos variantes non.
--
-- Deux colonnes suffisent : `processed_at` (le média est passé, avec ou
-- sans succès — le job ne retraite pas en boucle une image morte) et
-- `process_error` (pourquoi, lisible en modération). Le retraitement
-- d'un échec est un geste volontaire : remettre `processed_at` à NULL.
-- =====================================================================

ALTER TABLE media ADD COLUMN processed_at timestamptz;
ALTER TABLE media ADD COLUMN process_error text;

-- La file du job : les médias jamais passés, plus anciens d'abord.
CREATE INDEX media_pending_idx ON media(created_at) WHERE processed_at IS NULL;
