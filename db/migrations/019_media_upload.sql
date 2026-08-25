-- =====================================================================
-- Envoi de photos depuis le back-office (écart de mise en production — §7).
--
-- Jusqu'ici les photos n'arrivaient que par les canaux automatiques (bot,
-- flux) ou par le seed : le back-office savait créer un bien sans image.
-- Il accepte désormais des fichiers, les dépose sur la couche de stockage
-- abstraite (locale ou S3 — celle des variantes) et laisse le job
-- `process-media` produire AVIF/WebP/JPEG comme pour n'importe quelle
-- autre source.
--
-- Trois décisions structurantes :
--
-- 1. LA SOURCE EST NÔTRE. Une photo envoyée est stockée telle quelle sous
--    `p/<média>/source.<ext>` avant d'être traitée : l'URL en base pointe
--    vers notre stockage, jamais vers un fichier temporaire du serveur.
--    Le job la lit exactement comme il lirait une photo Telegram.
--
-- 2. Le type est SNIFFÉ, pas déclaré : l'extension et le `Content-Type`
--    du navigateur ne sont que des affirmations. Seuls JPEG, PNG, WebP et
--    AVIF, reconnus à leurs premiers octets, sont acceptés — pas de SVG
--    (script), pas de HEIC (sharp ne le décode pas partout).
--
-- 3. L'auteur est retenu (`uploaded_by`) : le back-office liste les envois
--    récents de chaque périmètre et permet de retirer une photo, avec
--    trace d'audit dans les deux sens — c'est la contrepartie d'un canal
--    manuel qui, contrairement au bot, n'a pas de conversation à relire.
-- =====================================================================

ALTER TABLE media ADD COLUMN uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN content_type text;
ALTER TABLE media ADD COLUMN byte_size    integer;

-- Les envois récents d'un périmètre : seule la poignée de médias envoyés à
-- la main est indexée, pas les milliers venus des flux.
CREATE INDEX media_uploaded_idx ON media(created_at DESC) WHERE uploaded_by IS NOT NULL;

ALTER TYPE audit_action ADD VALUE 'media_uploaded';
ALTER TYPE audit_action ADD VALUE 'media_removed';
ALTER TYPE audit_target ADD VALUE 'media';
