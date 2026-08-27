# Portail immobilier Cambodge — implémentation

Mise en œuvre du brief `roadmap-portail-immobilier-cambodge.md`. Les **phases
1 (MVP consultable)** et **2 (ingestion à l'échelle)** sont complètes, à une
réserve près : les deux composants qui appellent un modèle — extraction du bot
et traduction — n'ont jamais tourné contre l'API réelle, faute de clé. La
**phase 3 (acquisition et revenus)** est engagée : pages SEO par quartier ×
type × langue, tableau de bord agence, et alertes email / Telegram sur
critères sauvegardés.

Le produit tient en une phrase : **un bien = une fiche**. Le portail affiche
une fiche unique par bien physique, avec la liste des agences qui le proposent
et leurs prix respectifs, la date de dernière confirmation de chaque annonce,
et un filtre « éligible étranger » qui applique les règles de propriété
cambodgiennes.

---

## Démarrage

Prérequis : Node ≥ 20, Docker.

```bash
npm install
cp .env.example .env.local     # déjà fait si le dépôt est intact
npm run setup                  # démarre PostGIS, migre, et charge le jeu de données
npm run dev                    # http://localhost:3000
```

`npm run setup` enchaîne :

| Commande | Effet |
|---|---|
| `npm run db:up` | Démarre PostgreSQL 17 + PostGIS 3.5 (port hôte **5433**) |
| `npm run db:migrate` | Applique `db/migrations/*.sql` (suivi dans `schema_migrations`) |
| `npm run db:seed` | Charge 77 localités, 361 alias, 22 immeubles, 12 agences, 500 biens, ~1 200 annonces actives |
| `npm run db:reset` | Repart de zéro (schéma + données) |

Le jeu de données est **déterministe** : un même seed rejoué produit
exactement la même base.

#### Partir de vraies annonces plutôt que du jeu engendré

```bash
npm run setup:real
```

Cette variante construit le socle (localités, immeubles, agences, comptes,
facturation) **sans fabriquer de biens**, va chercher ~1 000 annonces réellement
publiées sur un portail cambodgien, puis rejoue l'activité de démonstration
(audience, contacts, dossiers de titre) sur ces biens-là. Voir « La collecte de
portails » pour ce qui est repris et ce qui ne l'est pas.

| Commande | Effet |
|---|---|
| `npm run db:seed-base` | Le socle seul, sans biens engendrés |
| `npm run portal:import -- --pages 25` | Collecte et importe les annonces |
| `npm run portal:photos` | Complète les galeries depuis la page de chaque annonce |
| `npm run media:process` | Télécharge les images et produit les variantes locales |
| `npm run portal:import-check` | Simulation d'une page, rien n'est écrit |
| `npm run portal:purge` | Retire tout ce qui provient d'un portail |
| `npm run seed:activity` | Rejoue vues, contacts et dossiers sur les biens présents |

**Les contrôles `db/checks/` visent le jeu engendré**, pas celui-ci : plusieurs
d'entre eux cherchent un bien précis — un projet neuf avec annonces, un condo
en titre strata, un bien proposé par plusieurs agences — que des données
réelles collectées sur un seul portail ne contiennent pas. Les lancer après
`npm run setup` ; `npm run check:portal` est le seul qui porte sur la collecte
elle-même, et il tourne hors ligne.

Le seed crée aussi les comptes du back-office et les affiche en fin
d'exécution. Mot de passe commun en développement : `cambodia-dev`.

| Compte | Rôle | Portée |
|---|---|---|
| `admin@khmerestate.kh` | `admin` | Modération : tout le back-office |
| `ips@khmerestate.kh` (et 3 autres) | `agency` | Uniquement les données de son agence |

---

## Ce qui est implémenté

### Le modèle (§3)

Séparation stricte `Property` / `Listing` — décision verrouillée n°1. Tout le
reste en découle : la fiche publique agrège les annonces, l'utilisateur ne voit
jamais une liste de `Listing`.

- `properties` — le bien physique, avec `foreign_eligible` en **colonne
  générée** : `title_type = 'strata' AND COALESCE(floor,0) >= 1`. La règle §5.3
  ne peut pas diverger entre le filtre, la fiche et le back-office puisqu'elle
  n'existe qu'à un seul endroit.
- `listings` — l'annonce d'une agence, avec `expires_at` à 45 jours,
  `last_confirmed_at`, `description_i18n` (JSONB) et la langue source.
- `price_history` — alimenté par déclencheur à chaque changement de prix.
- `locations` — arbre province → district → commune → quartier, avec
  `aliases[]`, le point le plus critique du produit.
- `media` avec `perceptual_hash`, `leads`, `search_misses`, `dedup_candidates`.

Contraintes qui font respecter les principes : `geo_point NOT NULL` (pas de
bien sans pin), unicité d'une annonce active par (bien, agence, transaction),
`transaction_type = 'rent'` impose `price_period = 'monthly'`.

### La recherche (§5)

- **Alias de romanisation** — `bkk one`, `kampong som`, `西港`, `សៀមរាប`,
  `toul kok`, `russian market`, `TK`, `diamond island` résolvent tous
  correctement. Le score combine égalité exacte, préfixe, sous-chaîne et
  similarité trigramme sur l'union des alias, du slug et des quatre libellés.
- **Recherches sans résultat journalisées** dans `search_misses` — c'est le
  meilleur indicateur de santé de la table d'alias (§10), et le back-office
  permet de transformer un terme non résolu en alias en un clic.
- **Filtres** : prix, type, chambres, salles de bain, surface, étage, type de
  titre, éligible étranger, meublé, équipements, fraîcheur, immeuble. Le
  formulaire de filtres est un **`<form method="get">` sans JavaScript** :
  sur Android d'entrée de gamme et réseau contraint, les filtres fonctionnent
  avant même que le JS ne soit arrivé.
- **Carte** : clustering, « rechercher dans cette zone », recherche
  automatique au déplacement (optionnelle), et **dessin de polygone** — les
  acheteurs raisonnent en « autour de BKK1 », pas en rayon kilométrique.

### L'internationalisation (§4)

Quatre locales complètes (`fr`, `en`, `zh`, `km`), 349 clés chacune, parité
vérifiée. URLs préfixées, `hreflang` complet plus `x-default`, sitemap avec
alternates par langue, négociation `Accept-Language` au premier passage puis
cookie.

Le khmer est traité comme un cas de première classe, pas comme un ajout :

- `line-height: 1.75` — les diacritiques débordent verticalement ;
- `word-break: normal` + `line-break: normal` — le khmer ne sépare pas les mots
  par des espaces, la coupure par défaut casse les syllabes ;
- aucune largeur fixe dans les composants — le khmer occupe 30 à 40 % de place
  en plus que l'anglais ;
- police Kantumruy Pro, sous-ensemble khmer chargé séparément, `display: swap`.

Les descriptions d'annonces sont stockées dans les quatre langues avec la
langue source, et **marquées visuellement** quand la traduction est machine.

### L'ingestion (§6) — ce qui est en place en phase 1

Le back-office (`/[locale]/backoffice`) applique les mêmes règles que le futur
bot Telegram :

- **le pin est une étape bloquante** — le bouton d'enregistrement est désactivé
  tant qu'aucun pin n'est posé, le contrôle est refait côté serveur, et la base
  refuse un bien sans coordonnées. Aucun géocodage d'adresse, nulle part ;
- **file de validation de déduplication** — signature composite
  `building + étage + surface + chambres`, jamais de fusion automatique sur cas
  ambigu ;
- **recherches sans résultat** à traiter en alias ;
- **relance J-7** — « toujours disponible ? » en un clic, qui repousse
  `expires_at` de 45 jours ;
- **photos réutilisées** — biens non liés partageant un hash perceptuel ; les
  paires servent bien la même image (voir « Les photos de démonstration ») ;
- **envoi de photos** — jointes à la création d'un bien, ou envoyées vers un
  bien existant par sa référence (`POST /api/backoffice/photos`, formulaire
  multipart sans JavaScript). Le type est reconnu aux premiers octets (JPEG,
  PNG, WebP, AVIF — jamais à l'extension ni au `Content-Type` annoncés), la
  source est déposée sur la couche de stockage des variantes (locale ou S3)
  avant que la ligne `media` n'existe, et le job `process-media` la traite
  comme n'importe quelle photo venue du bot. Le panneau liste les envois
  récents du périmètre avec leur état (en attente, variantes prêtes, échec)
  et permet de retirer une photo — envoi et retrait sont journalisés.
  `npm run check:upload` couvre reconnaissance du type, bornes, nettoyage
  d'un dépôt refusé, périmètre d'agence et passage du job.

### L'authentification du back-office

Le back-office mélange deux publics — l'équipe de modération et les agences
partenaires — qui ne doivent pas voir la même chose. Deux rôles :

| | `admin` | `agency` |
|---|---|---|
| Saisie d'un bien | oui | oui, sous sa propre agence uniquement |
| Relance des annonces | toutes | les siennes uniquement |
| Leads | tous | les siens uniquement |
| File de déduplication | oui | **non** — fusionner touche les annonces d'agences tierces |
| Recherches sans résultat, photos réutilisées | oui | **non** |
| Journal d'audit, export, rétention | oui | **non** |

Choix de mise en œuvre :

- **Sessions en base plutôt que jetons signés.** Une session doit pouvoir être
  révoquée immédiatement — agent qui quitte une agence, poste compromis. La
  base est déjà là, et le coût d'une requête par rendu est négligeable devant
  cette propriété.
- **Le jeton n'est jamais stocké.** La table `sessions` ne garde que son
  SHA-256 : une fuite de la base ne permet pas d'usurper une session en cours.
- **scrypt** pour les mots de passe (sel aléatoire de 16 octets, clé de 64,
  comparaison à temps constant), sans dépendance supplémentaire.
- **Pas d'énumération de comptes.** Une adresse inconnue déclenche quand même
  une vérification contre un haché factice : même temps de réponse, même
  message d'erreur qu'un mot de passe faux.
- **Limitation des tentatives** : 5 échecs par adresse en 15 minutes, 20 par IP.
  Le blocage s'applique aussi à un mot de passe correct pendant la fenêtre.

Trois niveaux de contrôle, avec des rôles distincts qu'il ne faut pas
confondre :

1. **Le middleware** redirige vers la connexion quand aucun cookie de session
   n'est présent. C'est du confort, pas de la sécurité : il tourne sur le
   runtime edge, ne peut pas interroger la base, et ne sait donc pas si le
   jeton est valide.
2. **Le layout du back-office** vérifie la session en base avant tout rendu.
   Il empêche l'affichage, pas l'exécution.
3. **Chaque action serveur** vérifie la session elle-même. C'est le point
   important : une action est un point d'entrée POST autonome, atteignable par
   quiconque connaît son identifiant, indépendamment de la page qui la
   contient. Une garde de layout ne la protège pas.

Le cloisonnement par agence est porté par les requêtes SQL, pas appliqué après
coup sur des données déjà chargées : `confirmListing` porte la condition
`agency_id = $2` dans son `UPDATE`, sans lecture préalable, donc sans fenêtre
entre la vérification et l'écriture.

La protection CSRF est celle de Next (contrôle de l'en-tête `Origin` sur les
actions serveur), complétée par un cookie `SameSite=Lax`, `HttpOnly`, et
`Secure` en production.

### Le journal d'audit

Toute action de modération est tracée dans `audit_log` : création de bien,
reconfirmation d'annonce, fusion de doublons, décision « biens distincts »,
ajout d'alias, connexion et déconnexion.

Deux propriétés font la différence entre un journal d'audit et une simple
table de logs :

**L'entrée est écrite dans la même transaction que la mutation.** Un journal
écrit après coup, au mieux, ne prouve rien : la fusion réussie dont la trace a
échoué est exactement le cas qu'on cherche à couvrir. Les actions passent donc
par `withTransaction`, et l'écriture du journal partage le sort de la
mutation. Vérifié en faisant échouer volontairement l'écriture du journal
pendant une fusion : le bien supprimé est revenu, les annonces aussi, le cas
est resté à trancher.

**La table est en ajout seul**, imposé par un déclencheur qui refuse `UPDATE`
et `DELETE`. La contrainte est dans la base plutôt que confiée à la discipline
du code applicatif — une entrée corrigeable après coup ne prouve rien non
plus. (Le seed contourne cela par un `TRUNCATE` explicite : remettre à zéro un
environnement de développement doit rester un geste conscient.)

L'auteur est conservé deux fois : par référence vers `users`, et par
instantané (`actor_email`, `actor_role`, `actor_agency`). Si le compte est
supprimé, on sait encore qui a agi. Même logique pour `target_label` : la
référence du bien supprimé lors d'une fusion n'est plus lisible nulle part
ailleurs.

Le détail est adapté à ce qui sera contesté. Une fusion enregistre le bien
conservé, le bien supprimé, le nombre d'annonces déplacées **et les annonces
détruites** — agence, type de transaction, prix. Une fusion supprime en effet
les annonces du doublon qui entrent en collision avec une annonce existante
(même agence, même type de transaction) ; c'est le comportement voulu, mais
c'est précisément ce qu'une agence viendra contester, donc le journal le
nomme.

Le journal est visible dans le back-office, réservé à la modération : un
compte d'agence ne doit pas savoir ce que fait une agence concurrente. Il s'y
filtre par action, par période et par auteur.

#### Export

`/api/audit/export?format=csv|jsonl` — réservé à la modération, et journalisé :
exporter un journal d'audit sort de la base des adresses, des adresses IP et
l'activité de toutes les agences, ce qui est en soi une action sensible.

L'export reprend exactement le filtre affiché, pas seulement les lignes
visibles. Il est produit en flux, par lots de 500, et figé sur un instantané
d'identifiants pris avant que l'export ne se journalise — sans quoi le fichier
contiendrait l'entrée décrivant sa propre production, et le nombre de lignes
annoncé ne correspondrait plus au contenu.

Le CSV porte un BOM UTF-8, sans lequel Excel abîme le khmer et le chinois, et
préfixe d'une apostrophe toute cellule commençant par `= + - @`. Ce n'est pas
de la cosmétique : les termes de recherche des visiteurs entrent dans le
journal par la file `search_misses`, et un tableur exécute une cellule qui
commence par `=`.

#### Rétention

```bash
npm run audit:retention -- --dry-run          # ce qui serait archivé, rien d'écrit
npm run audit:retention                        # archive puis purge
npm run audit:verify -- var/audit-archive/…    # l'archive correspond-elle au journal ?
```

Rétention par défaut : **730 jours** (`AUDIT_RETENTION_DAYS`). Archives dans
`var/audit-archive` (`AUDIT_ARCHIVE_DIR`).

L'ordre archive → purge n'est pas négociable, et il est imposé à trois
niveaux :

1. **Le job** écrit le fichier, le **relit depuis le disque** et calcule
   l'empreinte SHA-256 sur les octets réellement écrits, pas sur la chaîne
   qu'il croit avoir produite. Il vérifie que le nombre de lignes correspond
   avant d'aller plus loin.
2. **La base** n'accepte de suppression qu'à travers `purge_audit_log()`, qui
   pose un drapeau local à la transaction — un `DELETE` ordinaire reste refusé,
   et un `UPDATE` l'est toujours. La fonction refuse sans nom d'archive ni
   empreinte, refuse les entrées encore sous rétention, et refuse de purger les
   entrées `audit_purged` : c'est leur chaîne qui atteste la continuité du
   journal là où des entrées ont disparu.
3. **La purge se journalise elle-même**, dans la transaction qui supprime :
   nombre d'entrées, période couverte, seuil appliqué, nom d'archive et
   empreinte.

`audit:verify` referme la boucle en recalculant l'empreinte d'une archive et en
la confrontant à ce que le journal déclare. Une archive absente, tronquée ou
retouchée d'une seule ligne ressort en échec avec un code de sortie non nul.

Limite à connaître : la base ne peut pas lire le système de fichiers. Elle
impose qu'une archive soit **nommée et empreinte**, pas qu'elle existe ni
qu'elle soit fidèle. C'est `audit:verify` qui l'établit, et c'est pourquoi il
doit tourner après chaque purge — ce que le lanceur planifié fait
automatiquement.

#### Planification

Voir la section **Tâches planifiées** plus bas : la rétention y est décrite
avec l'expiration des annonces, les deux partageant le même socle.


### La monétisation (§8)

Le **tracking des leads existe dès la v1**, comme demandé : chaque révélation
de numéro, appel, message Telegram ou WeChat est enregistré avec le bien,
l'annonce, l'agence, l'agent, la langue et l'horodatage. Sans cela rien n'est
facturable ni démontrable.

---

## Phase 2 — ingestion à l'échelle

Objectif du brief : « l'offre s'alimente sans intervention interne ».

| Élément de la phase 2 | État |
|---|---|
| Moteur de déduplication + file de validation | **fait** |
| Hash perceptuel des photos | **fait** — dHash réel |
| Import XML / CSV | **fait** |
| Collecte d'un portail public | **fait** — realestate.com.kh, faits seuls |
| Cycle d'expiration 45 j | fait (phase 1) |
| Historique de prix | fait (phase 1) |
| Dessin de polygone | fait (phase 1) |
| Extension SR / SHV / Kampot / Battambang | fait (données) |
| Bot Telegram + extraction LLM | **écrit** — jamais exécuté contre l'API réelle (aucune clé disponible) |
| Relances automatiques J-7 | **fait** |
| Traduction automatique à l'ingestion | **écrit** — jamais exécuté contre l'API réelle |

### L'entonnoir commun

Les quatre canaux — bot Telegram, flux XML/CSV, back-office, collecte de
portails — déposent la même chose : une **soumission**. C'est
`db/lib/ingest.mjs` qui décide ensuite où elle atterrit. Faire passer les quatre
par le même entonnoir est ce qui garantit qu'aucun ne peut contourner la règle
du pin manuel.

Le socle est en ESM simple et prend son client PostgreSQL en paramètre : la
même logique sert au job d'import, à l'action du back-office et, demain, au
worker du bot. Il n'y a pas deux implémentations à tenir d'accord.

`submissions` porte un index unique sur `(agency_id, source, external_ref)` :
réimporter le flux nocturne d'une agence ne duplique rien. Vérifié en rejouant
le même fichier — 3 annonces, 3 « déjà importées », 0 création.

### Le pin, un cran plus loin

Une nuance qui n'apparaît qu'une fois la déduplication en place : **le pin
n'est exigé que pour créer un nouveau bien**. Une annonce rattachée à un bien
existant hérite du pin déjà posé. C'est précisément ce que la déduplication
fait gagner aux agences — et ce qui rendra le canal Telegram supportable pour
un agent sur son téléphone.

Une annonce qui n'apporte qu'une adresse texte n'est jamais géocodée : elle
attend en `needs_pin` dans le back-office, où un humain la pointe sur la carte.
Des coordonnées explicites venues d'un CRM sont acceptées — quelqu'un les y a
posées.

### Le moteur de déduplication (§6.2)

Trois issues, et une règle qui prime : « ne jamais laisser l'algorithme
fusionner seul les cas ambigus ».

- **Fusion automatique** uniquement sur une correspondance déterministe : même
  immeuble identifié, même étage, même nombre de chambres, surface à 2 % près.
  Rien d'interprétable.
- **File de validation** pour tout le reste au-dessus du seuil, **y compris une
  correspondance photographique parfaite** sans corroboration structurelle.
- **Nouveau bien** en dessous du seuil.

Une agence face à sa propre annonce n'est jamais fusionnée automatiquement :
c'est une mise à jour, pas un doublon inter-agences.

#### Ce que les annonces réelles ont appris au moteur

Sur le jeu engendré, la file de validation comptait une trentaine de paires et
tout paraissait sain. Sur ~900 annonces collectées, elle est montée à 328 —
48 % des biens —, et l'indicateur de santé (§10) a rendu le chiffre visible. En
regardant ce qu'elle contenait, une fois les vraies empreintes de photos
calculées :

| | |
|---|---|
| Paires mises en file par l'entonnoir | 301 |
| … partageant une photographie | **14** |
| … dont les photos n'ont aucun rapport | **286 (95 %)** |
| Paires réellement photo-identiques dans la base | 116 |
| … présentes dans la file | **15** |

Une file **à la fois bruyante et aveugle**, donc, et pour une seule raison : la
déduplication **décidait avant que la preuve n'existe**. `ingest()` reçoit les
empreintes de `input.photos` ; les canaux qui n'apportent qu'une URL — collecte
de portail, flux CRM — n'en ont aucune à ce moment-là, puisque les images ne
sont téléchargées et hachées que plus tard par `process-media`. Le seul signal
que le brief qualifie de vraie corroboration était absent au moment de la
décision.

Ne restaient que les signaux faibles. Et 0,20 (même étage) + 0,10 (mêmes
chambres) tombe **exactement** sur le seuil de mise en file : « même commune,
même type, même numéro d'étage, même nombre de chambres » suffisait. À Siem
Reap, cela décrit un quartier. Second défaut, indépendant : le score
**n'additionnait que des accords**. Une villa de 184 m² à 250 000 $ était
appariée à une de 684 m² à 4 500 $/mois, le désaccord ne pesant rien.

Trois changements, tous mesurés plutôt que devinés :

1. **Le désaccord compte.** Au-delà de 25 % d'écart de surface, la note baisse
   au lieu d'ignorer la contradiction.
2. **Sans immeuble identifié, l'accord structurel ne suffit plus** : il faut
   une corroboration — photo à distance ≤ 10, ou immeuble commun. La règle ne
   s'applique QUE si les photos ont pu être regardées ; un canal qui n'en
   fournit pas retombe sur le comportement d'origine, parce qu'une file trop
   large vaut mieux qu'un doublon publié sans que personne ne l'ait vu.
3. **La file est réévaluée quand la preuve arrive** — `ops/rescan-duplicates.sh`,
   à lancer après `ops/process-media.sh`. Deux passes : élagage des paires que
   les photos ne soutiennent pas, rattrapage de celles qu'elles révèlent. Le
   job ne fusionne jamais : il dépose, un humain tranche.

Résultat sur le même jeu : **48 paires au lieu de 328, dont 47 partagent une
photographie**, et l'indicateur passe de 48 % à 9,7 % des biens. Une file qui
se travaille.

Il reste un angle mort assumé : la présélection ne regarde que « même immeuble »
ou « même quartier et même type ». Vingt-cinq paires photo-identiques portent un
type de bien différent chez la source, cinq un quartier différent — elles
échappent encore au rattrapage. Les rattraper demanderait d'élargir la
présélection à l'empreinte photographique seule, ce qui change le coût de
chaque ingestion : à faire quand le volume le justifiera.

`npm run check:dedup` couvre les règles hors ligne, sur des paires fabriquées —
c'est le seul moyen d'atteindre les cas limites qu'un jeu de données ne fournit
pas à volonté.

### Le hash perceptuel, et sa limite

Les agences se repiquent les images — fait de marché, donc signal exploitable.
Mais elles les recompressent, les recadrent, les filigranent : une comparaison
octet à octet ne trouve rien. Le dHash (9×8 en niveaux de gris, 64 bits) ne
retient que la structure, et `phash_distance()` donne la distance de Hamming
directement en SQL.

Seuils **mesurés**, pas devinés :

| Transformation | Distance |
|---|---|
| JPEG qualité 30 | 1 |
| Réduction de moitié | 1 |
| Recadrage 8 % | 3 |
| Filigrane | 4 |
| Dix images sans rapport | 11 à 33 |

D'où ≤ 6 pour « même photo », zone grise jusqu'à 10, juste sous le minimum
observé pour des images différentes.

**La limite, découverte en calibrant** : dHash ne lit que la structure
grossière. Deux photos réellement différentes mais de composition très proche —
deux studios identiques du même immeuble, pris au même endroit — tombent à une
distance nulle. Le hash est donc une **corroboration, jamais une preuve** : le
moteur ne fusionne jamais sur ce seul signal.

### Les photos de démonstration

Cette section décrit le jeu de données **engendré** ; les annonces collectées
sur un portail montrent, elles, les photographies de l'annonce d'origine (voir
« La collecte de portails »).

Le jeu de données n'invente pas d'images : il pioche dans **83 photographies
libres de droits** (licence Unsplash — usage commercial autorisé, aucune
attribution obligatoire) déposées dans `public/demo-photos/`, créditées une à
une dans `public/demo-photos/CREDITS.md`. Toutes sont recadrées en 1600 × 1067,
JPEG progressif qualité 80 — les dimensions que le seed déclare dans
`media.width` / `media.height`, pour ~21 Mo au total.

Elles sont rangées par catégorie : `condo`, `villa`, `borey`, `shophouse`,
`flat`, `land`, `penthouse`, `commercial`, `warehouse`, `building-exterior`.

Le seed n'enregistre pas un chemin de fichier mais une **graine** :

```
/api/photo/{property_type}-{8 premiers caractères de l'id du bien}-{index}
```

`src/app/api/photo/[seed]/route.ts` la relit et sert le JPEG correspondant :

- le **type** choisit la catégorie — un condo montre des intérieurs
  d'appartement, un terrain une parcelle, un entrepôt un hall industriel ;
- l'**index 0** est la vue extérieure de la fiche : la façade d'immeuble pour
  les biens en étage (`condo`, `whole_building`), la catégorie du type sinon,
  puisqu'elle est déjà faite de vues extérieures ;
- l'**identifiant** fige la sélection. Un mélange déterministe donne à chaque
  bien son propre ordre de parcours dans la catégorie : les photos d'une fiche
  sont stables d'un rechargement à l'autre et distinctes entre elles.

Une graine dont le type est inconnu retombe sur l'ancien visuel synthétique en
SVG : la route ne renvoie jamais 404 dans une fiche.

**Le point qui n'est pas cosmétique** : le seed fabrique volontairement des
photos repiquées d'une agence à l'autre, avec des empreintes à quelques bits de
distance, pour alimenter la file « photos réutilisées ». Une photo repiquée
reprend donc **la graine de l'image d'origine**, pas seulement son empreinte
dérivée. Sans cela, deux médias à distance ≤ 6 afficheraient deux images sans
rapport et la file de modération n'aurait aucun sens à l'œil. La règle tient
sur le jeu courant : les 754 paires de médias à distance ≤ 6 pointent
**toutes** vers le même fichier local — c'est vérifiable en une requête.

```sql
SELECT count(*) AS paires, count(*) FILTER (WHERE a.url = b.url) AS meme_fichier
FROM media a JOIN media b ON b.id > a.id AND b.property_id <> a.property_id
 AND phash_distance(a.phash, b.phash) <= 6;
```

Conséquence assumée : ~2 % des médias portent dans leur URL le type d'un autre
bien. C'est exactement la définition d'une photo volée, et le seul endroit où
l'image ne correspond pas au type de la fiche.

### La collecte de portails (canal 4)

Le jeu de démonstration engendré reste utile pour développer, mais il ne prouve
rien sur des données réelles. Le quatrième canal va donc chercher les annonces
déjà publiques sur un portail cambodgien — aujourd'hui **realestate.com.kh** —
et les fait entrer par le même entonnoir que les autres.

```bash
npm run portal:import-check          # simulation, une page, rien d'écrit
npm run portal:import -- --pages 25  # ~1 000 annonces, vente et location
npm run portal:purge                 # retire tout ce qui vient d'un portail
```

**Ce qui est repris, et ce qui ne l'est pas.** C'est la décision structurante,
et elle est autant juridique que technique :

| | |
|---|---|
| Repris | prix, transaction, type, chambres, salles d'eau, surfaces, étage, commune, coordonnées, référence, URL d'origine, **adresse des photographies** |
| Non repris | le titre et le texte de l'annonce, le nom, le téléphone et le courriel des agents |

La description est **régénérée** dans les quatre langues depuis les seuls
champs structurés (`db/lib/describe.mjs`, le même code que le seed) : c'est le
principe n°3 appliqué à la lettre, et cela évite de recopier le travail
éditorial d'un tiers. Une seule agence est créée par portail, sans
interlocuteur nommé : la voie de contact affichée sur la fiche est un lien vers
l'annonce d'origine, qui sert en même temps d'attribution.

**Les photos sont celles du bien.** `media.url` retient l'adresse de l'image
chez la source — c'est la référence et la trace de provenance — puis le
pipeline des médias la télécharge et en produit nos variantes AVIF/WebP/JPEG,
exactement comme pour une photo arrivée par le bot.

Ce détour n'est pas de la coquetterie d'architecture. **Le serveur d'images de
la source répond 403 à un navigateur qui affiche l'image depuis un autre site**
(protection anti-hotlink Cloudflare : `curl` obtient 200, Chrome reçoit une
page HTML de refus, que le navigateur bloque en `ERR_BLOCKED_BY_ORB`). Une
fiche qui pointerait directement chez elle n'afficherait que des cadres vides.
C'est ce qui rend les variantes indispensables ici — et elles vivent sous
`var/media/`, hors dépôt, ou sur le stockage S3 en production : le dépôt ne
transporte aucune image.

Le texte alternatif publié par la source n'est pas repris : la fiche fabrique
le sien depuis le type de bien et le quartier. Les vignettes de carte
engendrées que la source mêle à ses galeries (`type: "map"`) sont écartées :
ce ne sont pas des photos du bien, et son serveur les refuse d'ailleurs.

La page de liste ne porte que la photo mise en avant, ce qui suffit aux cartes
de résultats. La galerie complète — cinq photos au plus — demande d'ouvrir la
page de chaque annonce, donc une passe séparée, reprenable et lancée à la main,
suivie du pipeline :

```bash
npm run portal:photos      # galeries, une requête par annonce
npm run media:process      # téléchargement et variantes locales
```

`process-media` accepte désormais `--concurrency` : sur un rattrapage de
plusieurs milliers d'images, traiter six médias de front fait passer la file de
deux heures à une vingtaine de minutes.

Une annonce sans aucune photo publiée retombe sur le fonds libre de droits
maison (voir « Les photos de démonstration »), pour ne pas laisser une fiche
nue dans les résultats.

**Politesse de collecte.** Un agent utilisateur identifiable, une requête à la
fois, 2,5 s entre deux pages, un nombre de pages borné par l'appelant, un arrêt
immédiat si le serveur refuse, et rien en dehors des chemins que le `robots.txt`
de la source laisse ouverts à `User-agent: *` — pour realestate.com.kh, les
listes `/buy/` et `/rent/` (relevé du 27/08/2026 ; `/api/`, `/dashboard/`,
`/admin/`, `/accounts/` et les pages d'impression sont fermés, et ne sont pas
lus). La collecte est une commande lancée à la main, pas une tâche planifiée.

**Trois pièges, trouvés sur les données réelles.** Ils ont tous la même
réponse : écarter l'annonce plutôt que publier une valeur fausse.

| Piège | Ce qui se passait | Règle retenue |
|---|---|---|
| Prix au m² | `"$740/m²"` lu comme un total mettait un terrain de 2,8 ha à 740 $ | multiplié par la surface, ou annonce écartée si la surface manque |
| Coordonnée absente | `Number(null)` vaut 0, et 0/0 est un point au large de l'Afrique | une position doit être un nombre, et tomber dans l'emprise du Cambodge |
| Commune approchante | « Phsar Kandal I » ressemblait assez à « Kandal » pour ranger une annonce de Daun Penh dans une autre province | correspondance quasi exacte exigée, sinon on remonte au district |

`npm run check:portal` couvre tout cela **hors ligne**, sur des pages
fabriquées à la main : un contrôle ne doit pas dépendre d'un site tiers pour
passer, et le dépôt n'a pas à embarquer du contenu recopié pour se tester. Il
vérifie aussi qu'aucun champ de texte libre ni de contact ne survit à la
traduction en faits.

**Ce qu'on n'invente pas non plus.** Le portail ne publie pas le régime de
propriété : les biens collectés restent en `title_type = 'unknown'`, et aucun
dossier de vérification de titre n'est fabriqué sur eux. Le panneau de
vérification et le badge public sont donc vides sur un jeu réel — attacher un
dossier fictif à une adresse qui existe serait fabriquer une affirmation
juridique sur un bien réel, ce qui est une autre affaire que meubler une démo.

**Ce que la collecte a révélé du moteur de déduplication.** Sur ~900 annonces
réelles, 0 fusion automatique et 301 paires en file de validation. Le chiffre
est élevé parce que le marché de Phnom Penh est fait d'immeubles où trente
unités partagent quartier, type, surface et nombre de chambres — précisément
les cas que le brief interdit de fusionner sans humain (§6.2). C'est le
comportement voulu, mesuré pour la première fois sur autre chose qu'un jeu
fabriqué.

### Le bot Telegram

C'est le canal que le brief désigne comme déterminant du volume (§6.1) : les
agents travaillent depuis Telegram sur leur téléphone, pas depuis un
back-office web.

```
idle ──texte/photos──► confirming ──✅──► awaiting_pin ──position──► publiée
                           │                                  │
                           └──✏️ corriger──► collecting ───────┘
```

**Le partage de position de Telegram est le pin manuel du principe n°2.** C'est
un geste de l'agent, à l'endroit du bien — pas un géocodage d'adresse. La
conversation ne peut pas aboutir sans lui, et c'est vérifié : tant que la
position n'est pas partagée, aucun bien n'est créé.

L'extraction utilise le SDK Anthropic avec un outil déclaré `strict: true` :
l'entrée renvoyée est garantie conforme au schéma, il n'y a donc pas de
validateur de secours pour du JSON approximatif. Le prompt système porte ce qui
change la lecture d'un message cambodgien — « 185k » vaut 185000, « borey » est
un type de bien, « strata » n'est pas un synonyme de « hard », et les quartiers
sont recopiés tels quels puisque c'est la table d'alias qui les résout.

```bash
TELEGRAM_BOT_TOKEN=… ANTHROPIC_API_KEY=… npm run bot
npm run bot:once           # un seul cycle de long polling
npm run bot:reminders      # relances J-7, à programmer quotidiennement
```

Le worker fait du long polling plutôt qu'un webhook : pas de domaine public ni
de certificat, et il tourne à côté de la base sans être exposé. Le décalage de
lecture est persisté — un redémarrage reprend où il s'est arrêté. Chaque mise à
jour est traitée dans sa propre transaction, et une mise à jour empoisonnée
fait quand même avancer le décalage plutôt que de bloquer la file.

La relance J-7 (§6.3) ferme la boucle de l'expiration : le message porte un
bouton dont le callback reconduit l'annonce de 45 jours sans quitter Telegram.
Sans elle, la fraîcheur affichée se paierait en annonces perdues.

#### Ce qui est vérifié, et ce qui ne l'est pas

`npm run check:bot` déroule la conversation complète — transport doublé,
extraction injectée, transaction annulée — et couvre 25 points : l'enchaînement
des états, le caractère bloquant du pin, les champs manquants, un quartier non
résolu, un chat non rattaché, la relance en un clic.

`npm run check:extraction` vérifie la requête que l'extracteur enverrait, sans
consommer de jeton : identifiant de modèle, outil strict, schéma fermé, outil
forcé, réflexion adaptative, absence de `budget_tokens` et de `temperature`
(retirés sur les modèles récents), absence de préremplissage assistant — plus
la lecture d'une réponse, d'un refus et d'une réponse sans appel d'outil.

**Ce que ces vérifications ne disent pas** : la qualité réelle de l'extraction.
Aucune clé d'API n'était disponible, le code n'a donc jamais tourné contre
l'API. Le contrat est conforme à la documentation du SDK ; la première
exécution réelle reste à faire, et c'est là qu'on verra si le prompt tient
face à un message d'agent en khmer translittéré.

### La traduction à l'ingestion

Le brief est précis sur le *quand* : les traductions sont générées à
l'ingestion, « pas à l'affichage — coût et latence ». Une fiche consultée mille
fois ne doit pas déclencher mille traductions.

**Un worker, pas un appel dans la transaction d'ingestion.** Traduire prend
plusieurs secondes ; le faire à l'intérieur de la transaction reviendrait à
tenir un verrou de base ouvert pendant un appel réseau, et à faire échouer la
publication d'une annonce parce qu'une API est indisponible. L'annonce est
publiée immédiatement dans sa langue source ; la traduction la rattrape. C'est
toujours « à l'ingestion » au sens du brief : une fois par annonce.

```bash
npm run translate:check     # ce qui serait traduit, sans rien appeler
npm run translate           # traite la file
npm run translate -- --retry --limit 50
```

Le volume est faible par construction : le principe n°3 pousse tout ce qui peut
l'être dans des champs typés, déjà traduits par les tables de référence. Ne
reste que la phrase libre de l'agent.

Le prompt interdit d'embellir — pas de « spacieux » ou « idéalement situé »
inventés, pas de fait retiré, chiffres et surfaces recopiés à l'identique. Les
termes de marché (borey, hard title, soft title, strata, flat, shophouse) ne
sont pas traduits : ils sont compris tels quels au Cambodge. La langue source
conserve le texte de l'agent mot pour mot plutôt qu'une reformulation.

L'effort est réglé bas : traduire n'est pas une tâche de raisonnement, et le
volume, lui, sera élevé.

**`machine_translated` est devenue une colonne générée** depuis
`translation_status`. L'état de traduction n'existe qu'à un seul endroit, et le
marqueur « traduction automatique » de la fiche publique ne peut pas diverger
de la réalité — vérifié de bout en bout : valider une traduction en
back-office fait disparaître le marqueur de la fiche.

**La relecture humaine ne concerne que les annonces premium**, comme le
demande §4.1. Elles passent devant dans la file — ce sont les seules où le
délai coûte deux fois — et le back-office les présente dans les quatre langues
côte à côte, la source repérée : ce qu'on relit est la fidélité, pas le style.
La validation est journalisée comme action de modération, puisqu'elle engage le
portail sur le contenu.

Les échecs sont marqués `failed` avec leur cause et ne sont **pas** repris
automatiquement : une annonce empoisonnée ne doit pas consommer la file à
chaque passage. `--retry` les reprend explicitement.

### Import de flux

```bash
node db/jobs/import-feed.mjs --file db/fixtures/ips-cambodia.xml --agency ips-cambodia --dry-run
node db/jobs/import-feed.mjs --file db/fixtures/century21.csv  --agency century-21-mekong
```

Le parseur ne fait que traduire un format en soumissions ; ajouter un troisième
format revient à écrire une fonction de lecture, pas une seconde logique
métier. Les quartiers sont résolus par la table d'alias — « BKK1 », « Toul Tom
Poung », « Sen Sok » atterrissent au bon endroit.

Les deux flux d'exemple contiennent délibérément la même unité chez deux
agences différentes. À l'import du second, le moteur fusionne (score 0,90 :
même immeuble, même étage, mêmes chambres, surface identique à 2 %) et la fiche
publique affiche « 2 agences proposent ce bien, de 182 500 $ à 185 000 $ ».

## Phase 3 — acquisition et revenus

| Élément de la phase 3 | État |
|---|---|
| Pages SEO par quartier × type × langue | **fait** |
| Alertes email et Telegram sur critères sauvegardés | **fait** |
| Facturation des abonnements, gestion des quotas | **fait** — cycle quotidien, quotas, factures, `npm run check:billing` |
| Mise en avant payante | **fait** — place achetée à durée limitée, quota par palier |
| Tableau de bord agence | **fait** |
| Vérification des agences (badge) | **fait** — le badge s'attribue depuis la modération, avec trace d'audit |
| Pages promoteurs / projets neufs | **fait** — `npm run check:projects` |
| Indicateurs de santé du portail (§10) | **fait** — panneau de modération, `npm run check:indicators` |
| Évaluation du mini-programme WeChat | à faire — décision produit, pas du code |

### Les indicateurs de santé (§10)

Le brief fixe huit indicateurs et une cible de fin de phase 2 pour chacun. Ils
n'étaient suivis nulle part : le back-office montrait des files de travail —
soumissions, doublons, recherches sans résultat — mais aucun chiffre disant si
le produit avance. Un panneau de modération les calcule désormais sur trente
jours (`src/lib/indicators.ts`).

Deux décisions ont plus compté que le reste.

**Un indicateur qu'on ne sait pas mesurer se déclare non mesuré.** Deux des
huit l'étaient : le LCP p75, qui demande une mesure côté navigateur, et le taux
de recherches sans résultat, qui demande un dénominateur — le nombre de
recherches abouties — que rien ne journalisait, puisque seuls les échecs le
sont (§5.2). Montrer les trous plutôt que de les remplir au jugé a dit quoi
instrumenter, et les deux le sont désormais (voir « L'instrumentation des deux
mesures manquantes »). Ils restent muets tant que la donnée n'est pas là :
sous vingt mesures pour le centile, sans aucune recherche mesurée pour le taux.

**Une approximation se dit comme telle.** Les « doublons résiduels » ne sont
pas observables : on ne connaît pas les doublons que le moteur a laissés
passer. Ce qui est mesuré est la part des biens engagés dans au moins une paire
non tranchée — un majorant, et un signal d'arriéré de modération autant que de
qualité. La première version rapportait les PAIRES aux BIENS et annonçait
455 % : un même bien apparaît dans plusieurs paires, et le rapport n'était pas
un taux. `npm run check:indicators` interdit désormais qu'un pourcentage
affiché dépasse 100.

**Et un indicateur ne doit pas mesurer le seed.** Le premier chiffre publié —
71 % des biens en file — venait à 92 % d'une requête de `db/seed/activity.mjs`
qui joignait chaque bien à *tous* ceux de même signature, pour peupler le
panneau de modération. Sur le jeu engendré, où les signatures se heurtent
rarement, cela donnait une trentaine de paires ; sur des annonces réelles, où
trente unités d'un même immeuble partagent quartier, type, chambres et surface,
le même produit cartésien en fabriquait 3 786. L'indicateur mesurait donc
surtout la façon dont le seed avait été écrit. La fabrication est désormais
bornée à une paire par signature — ce que le moteur produit vraiment, puisque
`findDuplicates` ne met en file que le meilleur candidat d'une soumission — et
plafonnée, une file de validation se travaillant à la main. Restent 301 paires
décidées par l'entonnoir sur les annonces collectées, contre 27 fabriquées.

Sur le jeu réel, le panneau est franchement rouge — 898 biens pour une cible de
3 000, 0 % d'annonces via le bot — et c'est précisément ce qu'on lui demande de
dire. Le troisième chiffre, lui, a rendu service autrement : les 48 % de biens
en file de déduplication ont conduit à examiner la file, à y trouver 95 % de
faux positifs, et à corriger le moteur (voir « Ce que les annonces réelles ont
appris au moteur »). Il est retombé à 9,7 %.

### L'instrumentation des deux mesures manquantes

Les deux trous du panneau n'étaient pas des oublis d'affichage : la donnée
n'existait pas. `db/migrations/021_instrumentation.sql` la crée.

**Le dénominateur des recherches.** `search_misses` ne retient que les échecs —
c'est ce qu'il faut pour écrire les alias, mais un numérateur seul ne fait pas
un taux. `search_events` compte désormais toute recherche en texte libre,
aboutie ou non. Trois décisions :

- **Mesure côté navigateur**, comme l'audience : une page de résultats se rend
  aussi à la pagination, au rechargement et au préchargement, sans que
  personne n'ait cherché quoi que ce soit.
- **Dédoublonnage par session et par jour** : quelqu'un qui reprend « bkk1 »
  toute la matinée en changeant ses filtres fait une recherche, pas quinze.
  Sans cela le dénominateur enflerait sur les recherches qui marchent — celles
  qu'on affine — et le taux d'échec paraîtrait meilleur qu'il n'est.
- **Le texte n'est pas conservé** : le serveur en prend une empreinte, qui
  suffit au dédoublonnage. Le texte des échecs est déjà gardé par
  `search_misses`, là où il sert.

**Le LCP.** Voir « Budget de performance » : la mesure est prise sur le
terrain, le facteur de forme déduit de l'agent utilisateur côté serveur — un
client peut se tromper ou mentir, et c'est lui qui sépare le p75 mobile du p75
de bureau, autrement flatté par les postes fixes.

Les deux tables sont des **mesures, pas des archives** : `ops/purge-metrics.sh`
les purge au-delà de soixante jours, le double de la fenêtre d'observation. Un
identifiant de session, même opaque, reste un identifiant ; le garder des
années après que la mesure a servi est exactement ce que le portail s'interdit
ailleurs. Ni adresse IP, ni URL complète, ni identifiant durable n'entrent dans
l'une ou l'autre.

`npm run check:indicators` couvre les deux bouts de la chaîne : dédoublonnage,
non-conservation du texte, robots écartés du dénominateur, facteur de forme
déduit du serveur, mesures aberrantes refusées, et la règle de silence des deux
indicateurs quand la donnée manque.

### Le tableau de bord agence

`/{locale}/dashboard` — ce que l'agence obtient pour son abonnement, et donc
l'argument de vente des paliers (§8).

Les leads étaient tracés depuis la v1. Il manquait le **dénominateur** :
combien de personnes ont vu la fiche pour qu'un contact se produise. D'où
`property_views`, et trois principes qui décident de la crédibilité du chiffre.

**Une vue porte sur un bien, pas sur une annonce.** Plusieurs agences peuvent
proposer le même bien et bénéficient toutes de la même page ; l'attribution se
fait à la lecture, via les annonces actives. C'est cohérent avec « un bien =
une fiche », et le tableau montre d'ailleurs combien d'agences se partagent
chaque bien.

**Le comptage est dédoublonné par session et par heure**, via un index unique
sur un `hour_bucket` généré. Un visiteur qui recharge dix fois ne vaut pas dix
vues. Les robots sont écartés sur l'agent utilisateur : ils consultent
beaucoup et ne contactent jamais, donc les compter écraserait le taux de
contact que les agences regardent. Un compteur qui gonfle est pire qu'une
absence de compteur — il fausse la décision d'achat dans le sens qui arrange
le vendeur.

**La mesure ne stocke ni adresse IP ni agent utilisateur**, et seulement
l'*hôte* du référent, jamais l'URL complète : ce qui est utile à une agence
c'est « depuis Google », pas la requête nominative d'un visiteur. Vérifié en
inspectant le schéma, pas seulement le code d'écriture.

Le comptage se fait côté client, par `sendBeacon` : la fiche est servie en ISR
avec revalidation, donc un rendu ne correspond pas à une visite.

Ce que le tableau montre, dans cet ordre : combien de gens ont vu mes biens,
combien m'ont contacté, et qu'est-ce qui cloche. Chaque mesure est comparée à
la période précédente — un chiffre brut ne dit pas si la situation s'améliore
— et le taux de contact est affiché à côté de celui du portail, parce qu'une
agence veut savoir si son résultat vient d'elle ou du marché :

> IPS Cambodia — 2 748 vues, 40 contacts, taux 1,5 %. Portail : 2,8 %.

S'y ajoutent l'origine des visites (le SEO travaille-t-il ?), les canaux et
langues de contact (où et en quelle langue répondre), la performance annonce
par annonce, et une liste « à traiter » qui remonte ce qui expire ou dort. Le
quota du forfait est affiché en rouge lorsqu'il est atteint — c'est le point de
bascule vers le palier supérieur.

La courbe est en SVG pur, sans bibliothèque : le budget de bundle est de 200 ko
(§7) et deux séries se dessinent en quelques lignes. Les contacts ont leur
propre échelle, sans quoi une courbe à 2 % serait collée à l'axe.

Un compte d'agence ne voit que la sienne ; la modération peut consulter
n'importe laquelle, ce qui sert à instruire une réclamation du type « je ne
reçois aucun contact ».

`npm run check:views` vérifie les treize points qui rendent ces chiffres
défendables : dédoublonnage, filtrage des robots, rejets de payload, absence
d'IP et d'agent utilisateur au schéma, réduction du référent à son hôte,
plausibilité du taux, et partage d'une vue entre agences co-listantes.

### Les pages d'atterrissage, et le piège de la combinatoire

`/{locale}/{buy|rent}/{quartier}[/{type}]` — par exemple `/fr/buy/bkk1/condo`.

Le SEO multilingue est le canal d'acquisition majeur du portail (principe n°5),
mais la combinatoire est un piège : 77 quartiers × 8 types × 2 transactions ×
4 langues font **4 928 URLs**. Sur l'inventaire actuel, seules 14 combinaisons
portent au moins cinq biens et 143 n'en portent qu'un seul. Générer les 4 928
produirait des milliers de pages quasi vides et quasi identiques — contenu
mince, budget d'exploration gaspillé, et un risque de dévaluation qui
retomberait sur tout le site.

**D'où la règle : une page n'est indexable qu'au-dessus d'un seuil
d'inventaire** (cinq biens). En dessous, elle reste consultable — un visiteur
qui suit un lien doit trouver quelque chose — mais porte `noindex, follow` et
sort du sitemap. Le seuil se franchit tout seul à mesure que l'offre grossit :
à l'objectif de 3 000 biens de la phase 2, la plupart des combinaisons utiles
l'auront passé. Aujourd'hui, le sitemap annonce 57 pages d'atterrissage sur
4 928 possibles.

L'invariant qui compte : **le sitemap et la balise `robots` portent sur
exactement le même ensemble**, tous deux dérivés de la même requête. Annoncer
une page qu'on demande par ailleurs à Google d'ignorer coûte du budget
d'exploration et de la crédibilité. C'est vérifié, pas supposé.

### Ce qui rend ces pages non dupliquées

Le texte est écrit depuis les chiffres réels de la combinaison — nombre de
biens, nombre d'agences, prix médian, prix au m², surface médiane, nombre de
chambres le plus fréquent, part de biens accessibles aux étrangers, part
confirmée depuis moins de 30 jours. Deux quartiers ne produisent donc pas la
même page :

> BKK1 — 17 biens vérifiés, proposés par 6 agences. Prix médian 296 000 $.
> Chroy Changvar — 6 biens vérifiés, proposés par 4 agences. Prix médian 549 000 $.

S'y ajoutent un maillage interne latéral (autres types du quartier, quartiers
voisins de même type), des données structurées `BreadcrumbList` + `ItemList`,
un canonical par langue et des `hreflang` complets avec `x-default`.

### Un choix assumé sur les URLs

Les segments de chemin restent en latin (`buy`, `rent`, `condo`) dans les
quatre langues. Des segments localisés seraient meilleurs pour le référencement
français, mais le khmer et le chinois ne se romanisent pas proprement, et le
percent-encoding produit des URLs illisibles. Le gain est marginal face au
titre, au H1, au contenu et aux `hreflang`, qui eux sont bien localisés — la
page chinoise s'intitule « BKK1公寓（Condo）出售 », pas une traduction
approximative.

`npm run check:seo` vérifie l'ensemble contre un serveur lancé : cohérence
sitemap ↔ `robots`, page mince consultable mais désindexée, page fournie
indexée, canonical et `hreflang` par langue, variance du contenu, maillage
interne, et non-masquage des routes existantes.

### Les alertes sur critères sauvegardés

`/{locale}/alerts?…` — le bouton « Créer une alerte » de la page de résultats y
mène avec les filtres courants. Le visiteur choisit un canal (email ou
Telegram) et une cadence (dès que possible, ou un résumé quotidien), et reçoit
ensuite les biens qui apparaissent sur ses critères. Pas de compte : une
alerte, c'est une adresse ou un chat, des critères, et deux jetons.

C'est le levier de fidélité le moins cher d'un portail, et celui qui alimente
les agences en contacts déjà qualifiés par leurs propres critères (§8).

**Une seule définition de « correspond ».** La page de recherche construit son
`WHERE` en TypeScript ; le job d'envoi tourne en Node, sans l'application.
Deux implémentations des filtres auraient dérivé — et un visiteur prévenu d'un
bien qu'il ne retrouve pas sur le site, ou pas prévenu d'un bien qu'il y
verrait, cesse de faire confiance à l'alerte. La sémantique des critères vit
donc dans une fonction SQL, `search_filter_matches(filters, since)`, et
`npm run check:alerts` confronte ses résultats à ceux de `/api/map` sur huit
combinaisons de filtres (quartier avec descente récursive, immeuble, types,
budget, chambres, surface, étage, titre, éligibilité étranger, équipements,
rectangle et polygone). La parité est vérifiée, pas supposée.

**Ce qui est « nouveau ».** Une annonce créée après l'inscription, sur un bien
correspondant. Une reconfirmation ou une baisse de prix ne redéclenche rien,
et un bien n'est signalé qu'une fois par alerte, même si une seconde agence le
met en ligne : la règle est une clé primaire (`alert_deliveries`), pas une
variable du job. Un redémarrage ne fait rien perdre ni rien répéter.

**Double opt-in.** On n'écrit jamais à une adresse qui n'a pas cliqué. Par
email, le lien de confirmation ; par Telegram, un lien profond
`t.me/<bot>?start=al_<jeton>` — c'est le `/start` dans le bot qui rattache le
chat et vaut confirmation. Le bot accepte aussi `/alerts` et `/stop`, et ces
commandes passent avant le contrôle du compte agent : elles viennent du
public. Chaque message porte un lien d'arrêt en un clic et un en-tête
`List-Unsubscribe`. Le jeton de confirmation est stocké sous forme
d'empreinte ; le jeton d'arrêt en clair, parce qu'il doit être réinséré dans
chaque message et que le pire qu'on puisse en faire est d'arrêter une alerte.

**Le transport email est une couche d'abstraction**, sur le modèle de la
cartographie : `MAIL_PROVIDER=file | resend | postmark`. Le mode `file`
n'envoie rien et ajoute chaque message à `var/mail-outbox.jsonl` — c'est le
mode de développement, où l'on relit le lien de confirmation dans le fichier,
et celui sur lequel s'appuie la vérification de bout en bout. Aucune
dépendance ajoutée : les deux fournisseurs s'appellent par leur API HTTP.

Le formulaire fonctionne sans JavaScript, comme le reste du site ; les
critères voyagent en champs cachés sous la même grammaire que l'URL de
recherche et sont relus par `parseFilters`. Un champ piège et trois plafonds
(alertes vivantes par adresse, créations par adresse et par IP et par heure)
tiennent les robots à distance ; une inscription dont le mail ne part pas est
supprimée plutôt que laissée en attente ; une inscription jamais confirmée est
purgée au bout de sept jours.

`npm run check:alerts` parcourt les soixante-trois points du circuit :
parité, forme canonique des critères, inscription, confirmation, déclenchement
par une nouvelle annonce, non-répétition, cadence quotidienne, rattachement
Telegram, `/stop`, garde-fous, et les pages.

## Mise en production

Ce qu'il faut pour servir le portail hors du poste de développement, dans
l'ordre où cela se fait. Tout est dans `ops/` et se rend avec le chemin
d'installation et l'utilisateur d'exécution substitués.

1. **Hôte** — Node 22+, PostgreSQL 17 + PostGIS, `pg_dump`/`pg_restore` de
   version au moins égale au serveur, un utilisateur système sans shell de
   connexion (`immo`) propriétaire du dépôt sous `/opt/cambodia-immo`.
2. **Environnement** — `/etc/cambodia-immo/env` (root:immo, 0640), sur le
   modèle de `.env.example` : `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`, transport
   email, jeton du bot, clé Anthropic, stockage des médias (`MEDIA_STORAGE=s3`
   et `MEDIA_PUBLIC_URL` = l'URL du CDN), `ARCHIVE_KEY` et `ARCHIVE_S3_BUCKET`.
   Le serveur web et les tâches lisent le même fichier ; le code, lui, ne
   contient aucune valeur de production.
3. **Construction et schéma** — sous l'utilisateur d'exécution :
   `npm ci && npm run build && npm run db:migrate`. Le seed n'est **pas**
   lancé en production.
4. **Serveur web** — `ops/systemd/cambodia-immo-web.service` (`next start`
   sur `127.0.0.1:3000`, `Restart=always`, système de fichiers en lecture
   seule sauf `var/` et `.next/cache`) :
   `sudo ops/install-scheduler.sh --web --user immo --root /opt/cambodia-immo`.
5. **Reverse proxy** — `ops/caddy/Caddyfile` : TLS automatique, compression,
   en-têtes de sécurité, et **retrait de l'instance du trafic** quand
   `/api/health` ne répond plus 200.
6. **Point de santé** — `GET /api/health` répond `200 {status:"ok"}` quand la
   base répond et que le schéma est au niveau du code, `503` sinon
   (`database_unreachable`, ou `migrations_pending` : un déploiement à moitié
   fait n'est pas un état sain). Jamais mis en cache, aucun secret.
   `npm run check:health` le vérifie, migration en attente simulée comprise.
7. **Tâches planifiées et sauvegardes** — section suivante ; la même commande
   d'installation pose les timers.

Déploiement d'une nouvelle version : `git pull`, `npm ci`, `npm run build`,
`npm run db:migrate`, `systemctl restart cambodia-immo-web` — dans cet ordre,
le point de santé signalant tout schéma en retard entre les deux derniers.

## Tâches planifiées

Six tâches tournent en dehors de l'application, sur un socle commun
(`ops/lib/job-runner.sh`) :

| Tâche | Cadence visée | Rôle |
|---|---|---|
| `ops/send-alerts.sh` | **toutes les 15 minutes** | Envoie les alertes dues ; purge les inscriptions non confirmées |
| `ops/process-media.sh` | **toutes les 15 minutes** | Génère et stocke les variantes WebP/AVIF/JPEG des médias en attente (§7) |
| `ops/rescan-duplicates.sh` | **toutes les heures**, après le traitement des médias | Réévalue la file de déduplication avec les empreintes désormais calculées (§6.2) |
| `ops/expire-listings.sh` | **horaire** | Bascule à `expired` les annonces passé 45 jours (§6.3) |
| `ops/billing.sh` | **quotidienne, 01:30** (après l'expiration de 01:00) | Cycle de facturation et de quotas : les places libérées profitent aux annonces retenues (§8) |
| `ops/backup-db.sh` | **quotidienne, 02:15** | Sauvegarde de la base : dump vérifié par `pg_restore`, chiffré, copié hors site, rotation |
| `ops/audit-retention.sh` | **hebdomadaire** | Archive puis purge le journal d'audit, et vérifie l'archive |
| `ops/purge-metrics.sh` | **hebdomadaire** | Purge recherches et mesures de terrain au-delà de 60 jours (§10) |

L'ordonnancement est fourni sous `ops/systemd/` — une unité modèle
`cambodia-immo@.service` (instanciée par tâche, durcie : `ProtectSystem=strict`,
seule `var/` est inscriptible, environnement dans `/etc/cambodia-immo/env`)
et cinq timers `Persistent=true` — avec un repli `ops/cron.d/cambodia-immo`
pour les hôtes sans systemd. `ops/install-scheduler.sh` rend les fichiers
(chemin et utilisateur d'exécution substitués), les installe, recharge et
active les timers ; `--dry-run` montre le rendu, `--cron` écrit le cron.d,
`--status` liste les timers :

```bash
sudo ops/install-scheduler.sh --user immo --root /opt/cambodia-immo
sudo ops/install-scheduler.sh --user immo --root /opt/cambodia-immo --dry-run
sudo ops/install-scheduler.sh --status
```

Les heures des timers suivent le fuseau de l'hôte (à poser sur
`Asia/Phnom_Penh`) ; le cron.d pose `CRON_TZ` lui-même. Les tâches ne
supposent rien de leur appelant — ni répertoire courant, ni `PATH`, ni
environnement de shell de connexion — ce qui est précisément le rôle du socle
décrit plus bas.

```bash
npm run alerts:send              # ops/send-alerts.sh
npm run media:process            # ops/process-media.sh
npm run listings:expire          # ops/expire-listings.sh
npm run db:backup                # ops/backup-db.sh
npm run audit:retention          # archive puis purge

npm run alerts:send-check        # simulation, aucune modification
npm run media:process-check      # simulation, aucune modification
npm run listings:expire-check    # simulation, aucune modification
npm run db:backup-check          # simulation, aucune modification
npm run audit:retention-check    # simulation, aucune modification
```

Les unités systemd sont préférables : `Persistent=true` rattrape une exécution
manquée pendant un arrêt de la machine, ce que cron ne fait pas. Un fichier
`/etc/cron.d` reste préférable à un crontab utilisateur — versionnable,
relisible en revue, utilisateur d'exécution nommé — et `CRON_TZ` y est posé,
sans quoi l'heure dépend de la configuration de l'hôte.

Vérification avant mise en service, dans l'environnement réel du serveur :

```bash
npm run listings:expire-check    # ops/expire-listings.sh --dry-run
npm run audit:retention-check  # ops/audit-retention.sh --dry-run
```

### Sauvegarde et restauration de la base

`ops/backup-db.sh` (job `db/jobs/backup-db.mjs`) enchaîne, chaque étape
prouvant la précédente : `pg_dump --format=custom` en mémoire ; relecture par
`pg_restore --list` — un dump que pg_restore ne sait pas lister ne
restaurera rien, autant le savoir la nuit même ; chiffrement AES-256-GCM avec
la clé des archives d'audit (`ARCHIVE_KEY`), relu-déchiffré avant que le
clair ne soit supprimé ; copie hors site sur le dépôt des archives
(`ARCHIVE_S3_BUCKET`, échec bruyant en code 1, la sauvegarde locale restant
intacte) ; rotation locale en dernier, qui ne retire que l'excédent au-delà
des `BACKUP_KEEP` plus récentes (14 par défaut). Une configuration cassée
(clé malformée, bucket sans accès) arrête le job avant le dump.

`pg_dump` et `pg_restore` sont des commandes configurables
(`BACKUP_PG_DUMP`, `BACKUP_PG_RESTORE`) : en développement elles passent par
le conteneur (`docker exec -i cambodia-immo-db pg_dump`, cf. `.env.example`),
en production ce sont les binaires de l'hôte, de version au moins égale à
celle du serveur.

Restauration — l'outil du jour de l'incident est `db/jobs/vault-open.mjs`,
qui ouvre tout fichier scellé par le coffre (sauvegarde ou archive d'audit) :

```bash
ARCHIVE_KEY=… node db/jobs/vault-open.mjs var/backups/db-2026-08-25T02-15-00.dump.enc   | pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL"
```

`npm run check:backup` exerce le cycle complet sur la base de développement
avec un faux bucket HTTP local : chiffrement, rotation, signature SigV4 de la
copie, réouverture par `pg_restore`, et les trois défaillances.
L'**exercice de restauration** sur une base vide, lui, reste une discipline
d'exploitation à tenir régulièrement — une sauvegarde jamais restaurée n'est
qu'une hypothèse.

### Pourquoi l'expiration tourne toutes les heures

Le portail affiche publiquement la date de dernière confirmation de chaque
annonce, et c'est son deuxième différenciateur (§1.3). Une annonce périmée qui
reste visible une journée entière abîme précisément la promesse qui distingue
le site de ses concurrents — §1.2 : « les portails existants conservent en
ligne des annonces vendues depuis plus d'un an ». La requête est un `UPDATE`
sur index partiel : son coût est négligeable, la cadence n'a donc pas à être
négociée contre lui.

La règle des 45 jours vit dans `expire_stale_listings()`, côté base. La tâche
ne fait que l'appeler : la règle ne doit pas exister en deux exemplaires.

Cette tâche **n'écrit pas dans le journal d'audit**. Celui-ci trace des
décisions humaines de modération ; une expiration est déterministe et
entièrement reconstituable à partir de `expires_at` et `last_confirmed_at`,
tous deux conservés. Y déverser des milliers de lignes automatiques noierait ce
qu'on y cherche.

Elle rapporte en revanche le nombre d'annonces entrant dans la fenêtre de
relance à J-7. C'est une observation, pas une action : le canal de relance
automatique est le bot Telegram, prévu en phase 2. En attendant, le back-office
propose la relance à la main et ce compteur dit combien de cas l'y attendent.

### Ce que le socle prend en charge

Ce sont les manières habituelles dont un cron échoue en silence :

- **Verrou `flock` par tâche** — deux exécutions simultanées se marcheraient
  dessus. Un chevauchement se termine avec le code 0 et une ligne de journal :
  l'exécution précédente fait déjà le travail, ce n'est pas une erreur. Chaque
  tâche a son propre verrou et ne bloque pas les autres.
- **Résolution explicite de `node`** — cron n'hérite pas du `PATH` d'un shell
  de connexion, donc nvm, asdf et volta sont invisibles. Le binaire est cherché
  via `NODE_BIN`, puis le `PATH`, puis les emplacements standard.
- **Chargement de `.env.local` sans `source`** — le fichier d'environnement est
  lu comme une liste de variables, pas exécuté comme un script. Une variable
  déjà définie l'emporte, ce qui permet à l'unité systemd de surcharger.
- **Répertoire de travail, horodatage, journal par tâche** — chaque ligne est
  datée, préfixée du nom de la tâche, et ajoutée à `var/log/<tâche>.log`.
- **Échec bruyant** — code de sortie 1 et message explicite. Sous systemd il
  apparaît dans `systemctl status` ; sous cron, le `MAILTO` reçoit la sortie.
  Attention au piège : sous bash, le trap `ERR` se déclenche **même** avec
  `set +e`, et masque le message d'erreur voulu par un « interrompu ligne N ».
  Les lanceurs utilisent `commande || status=$?`, forme qu'errexit et le trap
  ignorent tous deux.

## Décisions prises sur les points ouverts (§13)

Ces choix sont des **valeurs par défaut argumentées**, pas des arbitrages
définitifs — ils restent à confirmer avec les chiffres réels.

1. **Cartographie** — MapLibre GL avec fonds OpenStreetMap par défaut, derrière
   une couche d'abstraction (`src/lib/map-provider.ts`). Basculer vers MapTiler,
   Protomaps ou Google ne demande que deux variables d'environnement ; le champ
   `renderer` documente explicitement que Google exigerait un second moteur de
   rendu. Aucun composant ne connaît le fournisseur.

   Le même composant sert deux usages, distingués par `mode` : `search` sur la
   page de résultats — dessin de zone, « chercher dans cette zone », suivi du
   déplacement — et `locate` sur la fiche, où la carte ne fait que situer un
   bien déjà choisi. Dessiner un polygone sur la fiche d'un appartement ne mène
   nulle part : ces commandes n'y sont plus affichées.

   **Sur mobile**, liste et carte ne tiennent pas côte à côte : en dessous de
   1180 px une bascule les alterne (`?view=map`). Elle vit au niveau de la
   coquille, pas dans l'en-tête des résultats — sinon elle disparaissait avec
   la colonne qu'elle masque, et on se retrouvait enfermé dans la carte sans
   retour vers la liste. En vue carte sur téléphone, la carte passe devant la
   colonne de filtres et prend la hauteur de l'écran : à 60 % de la hauteur,
   sous un panneau de filtres déplié, elle se manipulait dans un hublot après
   un écran entier de défilement. Le parcours complet tient sans JavaScript
   côté page : basculer, déplacer, « chercher dans cette zone », toucher un
   point, ouvrir la fiche.

   MapLibre est un moteur **WebGL** : sans contexte WebGL — navigateur ancien,
   accélération matérielle coupée, pilote sur liste noire — il lève à la
   construction. L'exception est rattrapée et le panneau affiche « la carte ne
   peut pas s'afficher », plutôt que de rester vide sous un « Chargement… » qui
   ne s'éteint jamais. La liste de résultats reste le chemin principal vers les
   biens ; la carte ne l'a jamais été.
2. **Périmètre v1** — Phnom Penh + Siem Reap + Sihanoukville, avec Kampot,
   Battambang, Kep et Ta Khmau amorcés. Le modèle couvre déjà les 25 provinces.
3. **Location incluse dès la v1** — le modèle et l'interface gèrent vente et
   location ; la retirer serait un filtre à poser, pas une refonte.
4. **Traduction automatique** — non branchée. Les descriptions sont produites
   depuis les champs structurés dans les quatre langues, ce qui reflète le
   principe n°3 (plus de champs typés, moins de texte libre). Le back-office
   stocke la description dans sa langue source et marque les traductions
   manquantes ; le worker de traduction est un travail de phase 2.
5. **Accès aux annonces** — tout public, coordonnées agent derrière un clic
   (« afficher le numéro ») qui alimente le tracking des leads.

---

## Budget de performance (§7)

Mesuré sur la construction de production, réponses gzippées :

| Mesure | Valeur | Budget |
|---|---|---|
| JS initial, page de résultats | ~150 ko (dont 40 ko de polyfills non exécutés par les navigateurs modernes) | < 200 ko |
| HTML page d'accueil | 11 ko | — |
| HTML page de résultats | 43–50 ko | — |
| MapLibre dans le bundle initial | **absent** — importé à la demande | — |

Ces chiffres viennent de la construction locale et ne prédisent pas le LCP sur
4G réelle depuis le Cambodge — c'est pourtant lui que le brief vise. La mesure
est donc **prise sur le terrain** : les navigateurs réels remontent leur LCP à
`POST /api/vitals` (`src/components/WebVitals.tsx`), le facteur de forme est
déduit de l'agent utilisateur côté serveur, et le p75 mobile apparaît dans les
indicateurs de santé. Il reste muet sous vingt mesures : un centile tiré de
trois relevés serait une précision inventée.

Trois précautions dans la collecte, chacune corrigeant une manière classique
de se mentir sur cette mesure : le LCP n'est envoyé qu'au masquage de la page,
parce que le navigateur en propose plusieurs candidats successifs et que
remonter le premier flatte le chiffre ; une page ouverte en arrière-plan n'est
pas mesurée, sa peinture ne disant rien de l'expérience ; et les valeurs
aberrantes sont refusées avant d'entrer en base, une mesure absurde faussant un
centile autant qu'une mesure manquante.

---

## Structure

```
db/
  migrations/001_schema.sql   Schéma complet, contraintes, vues, déclencheurs
  migrations/002_auth.sql     Comptes, sessions, limitation des tentatives
  migrations/003_audit.sql    Journal d'audit en ajout seul
  migrations/004_audit_retention.sql  Purge encadrée, valeurs d'énumération
  migrations/005_audit_purge_fn.sql   purge_audit_log() : unique voie de suppression
  seed/locations.mjs          Hiérarchie administrative + 361 alias
  seed/seed.mjs               Générateur déterministe du jeu de données
  jobs/expire-listings.mjs    Expiration à 45 jours (appelle la fonction SQL)
  jobs/audit-retention.mjs    Archivage puis purge du journal d'audit
  jobs/audit-verify.mjs       Confrontation archive ↔ journal
  jobs/import-feed.mjs        Import XML / CSV vers l'entonnoir
  lib/portal.mjs              Collecte de portails : faits seuls, politesse, garde-fous
  jobs/import-portal.mjs      Import des annonces collectées vers l'entonnoir
  lib/describe.mjs            Description engendrée depuis les champs structurés
  seed/activity.mjs           Audience, contacts et dossiers sur les biens présents
  checks/portal.mjs           Collecte : traduction en faits, écarts, parcours (hors ligne)
  checks/indicators.mjs       Indicateurs §10 : définitions, accès, valeurs affichées
  checks/dedup.mjs            Règles du moteur de déduplication (hors ligne)
  jobs/rescan-duplicates.mjs  Réévaluation de la file une fois les photos hachées
  migrations/021_instrumentation.sql  Recherches mesurées et LCP de terrain
  jobs/purge-metrics.mjs      Purge des mesures au-delà de la fenêtre d'observation
  lib/ingest.mjs              Entonnoir commun aux canaux d'ingestion
  lib/dedup.mjs               Moteur de déduplication (§6.2)
  lib/phash.mjs               dHash 64 bits, seuils mesurés
  lib/telegram.mjs            Transport Telegram + double en mémoire
  lib/bot.mjs                 Machine à états de la conversation
  lib/extract.mjs             Extraction LLM (outil strict)
  lib/translate.mjs           Traduction + file (§4.1)
  jobs/translate-listings.mjs Worker de traduction
  jobs/telegram-bot.mjs       Worker long polling
  jobs/send-reminders.mjs     Relances J-7
  migrations/012_alerts.sql   Alertes : tables, search_filter_matches(), purge
  lib/alerts.mjs              Alertes : inscription, confirmation, envoi, rendu
  lib/mail.mjs                Transport email (file | resend | postmark) + double
  lib/messages.mjs            Messages traduits depuis les jobs Node
  jobs/send-alerts.mjs        Envoi des alertes dues
  checks/alerts.mjs           Parité SQL ↔ page, circuit complet, pages
  checks/bot-conversation.mjs Conversation complète, sans jeton
  checks/extraction-contract.mjs  Contrat de requête, sans appel
  checks/translation.mjs      Contrat + file de traduction, sans appel
  checks/seo-landing.mjs      Cohérence sitemap ↔ robots, balises, contenu
  checks/view-tracking.mjs    Dédoublonnage, robots, vie privée, cohérence
  fixtures/                   Flux d'exemple XML et CSV
  checks/dedup-merge.mjs      Vérification de la fusion (transaction annulée)
ops/
  lib/job-runner.sh           Socle commun : verrou, environnement, node, journal
  send-alerts.sh              Lanceur — envoi des alertes
  expire-listings.sh          Lanceur — expiration des annonces
  audit-retention.sh          Lanceur — rétention du journal d'audit
messages/                     fr · en · zh · km — 609 clés, parité vérifiée
src/lib/
  search.ts                   Filtres, requêtes, résolution d'alias, fiche bien
  i18n.ts                     Locales, traducteur, négociation, champs JSONB
  map-provider.ts             Couche d'abstraction cartographique
  seo.ts                      Pages d'atterrissage : seuil, stats, maillage
  dashboard.ts                Mesures du tableau de bord agence
  indicators.ts               Indicateurs de santé du portail (§10) et cibles
  alerts.ts                   Alertes : branchement de l'application sur lib/alerts.mjs
  auth.ts                     Mots de passe, sessions, gardes de rôle
  audit.ts                    Écriture du journal, filtres, flux d'export
  format.ts                   USD par défaut, KHR secondaire, fraîcheur
src/components/               Carte, filtres, fiches, badges, pin bloquant
src/app/[locale]/             Accueil · recherche · fiche · agence · alertes · connexion · back-office
src/app/api/                  suggest · map · leads · photo · searches · vitals · audit/export
public/demo-photos/           83 photos libres de droits + CREDITS.md
```

---

## Ce qui n'est pas fait

Hors périmètre de la phase 1, conformément à la roadmap :

- **première exécution réelle du bot et de la traduction** — le code est écrit
  et sa logique vérifiée hors ligne, mais il n'a jamais parlé à Telegram ni à
  l'API Anthropic. La qualité de l'extraction et des traductions reste à
  établir ;
- **transcription des messages vocaux** — le brief les mentionne (§6.1) ; le
  bot demande aujourd'hui du texte ;
- **alertes : premier envoi réel** — le circuit est vérifié de bout en bout avec
  le transport `file` et le double Telegram ; Resend et Postmark n'ont pas
  encore été appelés avec une clé réelle, et la délivrabilité (SPF, DKIM,
  domaine d'envoi) reste à établir sur l'hébergement — les invitations et
  réinitialisations de mot de passe empruntent le même transport ;
- **mots de passe du seed** — la gestion des comptes est complète (création
  en modération, invitation par lien à usage unique, réinitialisation,
  désactivation immédiate, second facteur TOTP auto-enrôlé), mais les mots de
  passe du seed restent des mots de passe de développement et aucun compte
  n'a de second facteur actif par défaut — chacun enrôle le sien.
- **garde de la clé d'archive** — les archives d'audit savent se chiffrer au
  repos (AES-256-GCM via `ARCHIVE_KEY`, le clair ne survit pas au disque) et
  se copier hors site (`ARCHIVE_S3_BUCKET`, même couche S3 signée que les
  médias), mais la clé vit dans l'environnement : sa garde (coffre, rotation)
  et l'exercice de restauration régulier restent une discipline
  d'exploitation, pas du code.
- **le socle juridique de la collecte** — la collecte de portails ne reprend
  que des faits, régénère les descriptions et ne stocke aucune donnée
  personnelle ; elle respecte le `robots.txt` de la source et se signale par
  un agent utilisateur identifiable. Elle **reproduit en revanche les
  photographies des annonces**, redimensionnées, sur notre propre stockage :
  ce sont des œuvres protégées, et c'est la décision qui demande le plus
  clairement l'accord de la source. C'est le
  maximum que le code puisse porter. Ce qu'il ne porte pas : l'examen des
  conditions d'utilisation du portail, la position à tenir sur le droit
  *sui generis* du producteur de base de données, et un accord — ou à défaut
  une notification — avec la source. Une mise en ligne publique demande de
  trancher ces trois points d'abord ; `npm run portal:purge` retire
  l'intégralité des données collectées d'une seule commande, ce qui est la
  contrepartie technique de cette réserve ;
- **médias réels** — le pipeline est en place (variantes AVIF/WebP/JPEG par
  `ops/process-media.sh`, stockage abstrait local/S3 signé SigV4, `<picture>`
  sur les fiches et les cartes), et les visuels de démonstration sont
  désormais de vraies photographies libres de droits servies par
  `/api/photo/[seed]` (voir « Les photos de démonstration ») ; l'envoi depuis
  le back-office est en place et exerce la même couche de stockage. Mais ces
  photos illustrent des biens fictifs : elles ne sont pas les médias des
  annonces. Le bucket réel et son CDN devant `/media/`
  (`MEDIA_STORAGE=s3`, `MEDIA_PUBLIC_URL`) restent à configurer sur
  l'hébergement.
