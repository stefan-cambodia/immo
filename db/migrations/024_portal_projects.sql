-- =====================================================================
-- Le programme immobilier d'une annonce collectée (§ projets neufs).
--
-- Le portail range les annonces d'un même programme sous son adresse :
-- `/new-developments/time-square-306/1-bed-1-bath-condo-267734/`. La page
-- de l'annonce le redit en clair, comme fait structuré et non comme
-- prose : `header.addressUrl` porte l'adresse du programme,
-- `header.address` son nom. Une annonce ordinaire n'a pas d'adresse de
-- programme (`addressUrl` vaut `null`) et son champ `address` est une
-- adresse postale — le discriminant est donc net, et rien n'oblige à
-- deviner.
--
-- Un nom de programme est un fait, au même titre que la commune ou le
-- prix : le reprendre ne contredit pas la décision n°1 de la migration
-- 020. Le titre de l'annonce, lui, reste dehors.
--
-- Ce que cette migration ajoute est la contrepartie de la décision n°3 :
-- un immeuble créé par la collecte doit pouvoir en repartir. Sans
-- provenance inscrite dans la donnée, `import-portal.mjs --purge`
-- retirerait les annonces et les biens en laissant les immeubles
-- derrière lui — des pages de projet vides, sans rien pour les relier à
-- la source dont elles viennent.
-- =====================================================================

-- L'adresse de la page du programme chez la source : provenance et
-- attribution, comme `listings.source_url` pour une annonce.
ALTER TABLE buildings ADD COLUMN source_url text;

-- Un programme n'entre qu'une fois, même si vingt de ses annonces le
-- nomment.
CREATE UNIQUE INDEX buildings_source_url_key
  ON buildings(source_url) WHERE source_url IS NOT NULL;
