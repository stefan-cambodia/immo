-- =====================================================================
-- « Toujours disponible ? » pour les annonces collectées (§6.3).
--
-- Une annonce saisie par une agence se reconfirme quand l'agent répond
-- à la relance J-7. Une annonce collectée n'a personne à relancer : sa
-- seule confirmation possible, c'est sa page chez la source. Jusqu'ici
-- rien ne la relisait — une collecte rejouée tombait sur une référence
-- connue et s'arrêtait là (« déjà importée ») — si bien que les 3 405
-- annonces collectées fin août et mi-septembre avaient toutes dépassé
-- leurs 45 jours au 28 octobre, sans qu'aucune ne soit retirée : la
-- tâche d'expiration ne tournait pas sur la machine de démonstration,
-- et l'aurait-elle fait, le catalogue entier serait parti d'un coup,
-- les annonces encore en ligne avec les autres.
--
-- `db/jobs/reconfirm-portal.mjs` relit donc la page de chaque annonce
-- qui entre dans sa dernière semaine. Ces deux colonnes gardent ce que
-- la source a répondu, et quand. Le retrait d'une annonce vendue ou
-- disparue est une décision prise sur une observation extérieure : à la
-- différence d'une expiration, elle ne se reconstitue pas à partir de
-- `expires_at` et `last_confirmed_at`, et doit donc laisser sa trace.
-- =====================================================================

ALTER TABLE listings
  ADD COLUMN source_checked_at timestamptz,
  -- Ce que la page disait : l'état publié par la source (`current`,
  -- `sold`, `leased`…) tel quel, ou `withdrawn` quand elle a disparu
  -- (HTTP 404/410). Texte libre plutôt qu'énumération : un état que la
  -- source ajouterait demain doit pouvoir s'écrire — et se compter —
  -- avant d'avoir été compris.
  ADD COLUMN source_state text;
