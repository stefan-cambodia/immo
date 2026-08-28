-- =====================================================================
-- Photos réutilisées : un préfiltre indexé avant la distance de Hamming.
--
-- Le tableau de bord cherche les paires de médias de biens distincts à
-- distance ≤ 6 (« même photo recompressée ou recadrée »). Écrite comme une
-- auto-jointure sur phash_distance(), la requête évalue toutes les paires :
-- avec 5 800 empreintes, c'est 17 millions d'appels et 13 secondes par
-- affichage du back-office — le temps pendant lequel un clic sur « Fusionner »
-- ou « Biens distincts » semble ne rien faire.
--
-- Principe des tiroirs : deux empreintes de 64 bits qui diffèrent d'au plus
-- 6 bits, découpées en 7 blocs, ont au moins un bloc identique (6 différences
-- ne peuvent pas toucher 7 blocs). Un index par bloc ramène donc la recherche
-- des voisins d'une empreinte à 7 consultations d'index, et phash_distance()
-- ne tranche plus que sur les quelques candidats restants. Mesuré sur le jeu
-- collecté : 13,7 s → 0,28 s, mêmes 394 paires.
--
-- La fonction n'est PAS déclarée STRICT : le planificateur ne remplace le
-- corps d'une fonction SQL stricte dans la requête appelante que sous des
-- conditions qu'une jointure ne remplit pas, et sans ce remplacement les
-- index ne servent à rien (retour au parcours complet). Une empreinte NULL
-- donne NULL, donc faux dans une condition de jointure : même résultat.
--
-- Le préfiltre ne vaut que pour un seuil ≤ 6 : au-delà, il faudrait moins de
-- blocs, donc plus larges — la garantie tombe.
-- =====================================================================

CREATE INDEX media_phash_blk1_idx ON media (substring(phash from 1 for 9))  WHERE phash IS NOT NULL;
CREATE INDEX media_phash_blk2_idx ON media (substring(phash from 10 for 9)) WHERE phash IS NOT NULL;
CREATE INDEX media_phash_blk3_idx ON media (substring(phash from 19 for 9)) WHERE phash IS NOT NULL;
CREATE INDEX media_phash_blk4_idx ON media (substring(phash from 28 for 9)) WHERE phash IS NOT NULL;
CREATE INDEX media_phash_blk5_idx ON media (substring(phash from 37 for 9)) WHERE phash IS NOT NULL;
CREATE INDEX media_phash_blk6_idx ON media (substring(phash from 46 for 9)) WHERE phash IS NOT NULL;
CREATE INDEX media_phash_blk7_idx ON media (substring(phash from 55 for 10)) WHERE phash IS NOT NULL;

CREATE FUNCTION phash_block_match(a bit(64), b bit(64)) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT substring(a from 1 for 9)  = substring(b from 1 for 9)
      OR substring(a from 10 for 9) = substring(b from 10 for 9)
      OR substring(a from 19 for 9) = substring(b from 19 for 9)
      OR substring(a from 28 for 9) = substring(b from 28 for 9)
      OR substring(a from 37 for 9) = substring(b from 37 for 9)
      OR substring(a from 46 for 9) = substring(b from 46 for 9)
      OR substring(a from 55 for 10) = substring(b from 55 for 10);
$$;

COMMENT ON FUNCTION phash_block_match IS
  'Condition nécessaire à phash_distance(a, b) <= 6 : au moins un des sept '
  'blocs des deux empreintes est identique. À placer AVANT phash_distance() '
  'dans une jointure, pour que les index media_phash_blk*_idx servent.';
