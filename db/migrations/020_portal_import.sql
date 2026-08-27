-- =====================================================================
-- Collecte des annonces publiées sur les portails immobiliers (§6.1).
--
-- Jusqu'ici les annonces n'entraient que par un canal où quelqu'un les
-- avait saisies : bot Telegram, flux CRM d'une agence, back-office. Le
-- quatrième canal est d'une autre nature — les annonces sont déjà
-- publiques sur un portail tiers, et c'est nous qui allons les chercher.
--
-- Trois décisions structurantes, et elles sont autant juridiques que
-- techniques :
--
-- 1. ON NE REPREND QUE DES FAITS. Prix, surface, nombre de chambres,
--    type de bien, commune, coordonnées : des données factuelles, non
--    protégeables en tant que telles. Le titre et le texte de l'annonce
--    d'origine ne sont NI récupérés, NI stockés, NI publiés — la
--    description est régénérée depuis les champs structurés par
--    db/lib/describe.mjs, comme pour n'importe quelle autre annonce
--    (§4.1). Les photographies du portail ne sont pas téléchargées : les
--    biens importés illustrent avec le fonds libre de droits maison
--    (public/demo-photos).
--
-- 2. AUCUNE DONNÉE PERSONNELLE. Les pages sources exposent le nom, le
--    téléphone et l'adresse électronique des agents. Rien de tout cela
--    n'entre en base. Une seule agence est créée par portail, avec un
--    interlocuteur générique ; le lien vers l'annonce d'origine
--    (`source_url`) est la voie de contact, et l'attribution.
--
-- 3. LA PROVENANCE EST INSCRITE DANS LA DONNÉE, pas dans un fichier de
--    configuration : `listings.source = 'portal'` et `source_url`
--    permettent à tout moment de retrouver, de recompter, et surtout de
--    RETIRER l'intégralité de ce qui vient d'un portail donné.
-- =====================================================================

ALTER TYPE listing_source ADD VALUE 'portal';

-- Le lien vers l'annonce d'origine : traçabilité de la collecte, et
-- attribution de la source sur la fiche publique.
ALTER TABLE listings ADD COLUMN source_url text;

-- Une annonce collectée n'entre qu'une fois, même si la page est revue.
CREATE UNIQUE INDEX listings_source_url_key
  ON listings(source_url) WHERE source_url IS NOT NULL;
