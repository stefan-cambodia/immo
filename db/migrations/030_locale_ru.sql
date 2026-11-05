-- =====================================================================
-- Cinquième langue du portail : le russe (§4).
--
-- `locale_code` type la langue partout où elle est enregistrée : langue
-- source d'une description, langues parlées d'un agent, langue d'une
-- alerte, d'une vue, d'une recherche, d'une métrique. Sans la valeur, la
-- première vue d'une fiche en russe serait refusée par la base.
--
-- Les données qui portent une valeur PAR langue — noms des localités,
-- descriptions engendrées des annonces collectées — ne se complètent pas
-- ici : leur texte russe vient de `db/seed/locations.mjs` et de
-- `db/lib/describe.mjs`, qu'une migration SQL ne peut pas lire. C'est le
-- rôle de `npm run locales:fill`, à lancer une fois après cette migration.
-- =====================================================================

ALTER TYPE locale_code ADD VALUE IF NOT EXISTS 'ru';
