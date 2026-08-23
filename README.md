# Portail immobilier Cambodge — implémentation

Mise en œuvre du brief `roadmap-portail-immobilier-cambodge.md`. Les **phases
1 (MVP consultable)** et **2 (ingestion à l'échelle)** sont complètes, à une
réserve près : les deux composants qui appellent un modèle — extraction du bot
et traduction — n'ont jamais tourné contre l'API réelle, faute de clé. La
**phase 3 (acquisition et revenus)** est engagée : les pages SEO par quartier ×
type × langue sont en place.

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

Quatre locales complètes (`fr`, `en`, `zh`, `km`), 291 clés chacune, parité
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
- **photos réutilisées** — biens non liés partageant un hash perceptuel.

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
| Cycle d'expiration 45 j | fait (phase 1) |
| Historique de prix | fait (phase 1) |
| Dessin de polygone | fait (phase 1) |
| Extension SR / SHV / Kampot / Battambang | fait (données) |
| Bot Telegram + extraction LLM | **écrit** — jamais exécuté contre l'API réelle (aucune clé disponible) |
| Relances automatiques J-7 | **fait** |
| Traduction automatique à l'ingestion | **écrit** — jamais exécuté contre l'API réelle |

### L'entonnoir commun

Les trois canaux — bot Telegram, flux XML/CSV, back-office — déposent la même
chose : une **soumission**. C'est `db/lib/ingest.mjs` qui décide ensuite où elle
atterrit. Faire passer les trois par le même entonnoir est ce qui garantit
qu'aucun ne peut contourner la règle du pin manuel.

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
| Alertes email et Telegram sur critères sauvegardés | à faire |
| Facturation des abonnements, gestion des quotas | à faire |
| Mise en avant payante | partiel — `listings.featured` existe et remonte au tri |
| Tableau de bord agence | **fait** |
| Vérification des agences (badge) | partiel — l'état existe et s'affiche, le circuit non |
| Évaluation du mini-programme WeChat | à faire |
| Pages promoteurs / projets neufs | à faire |

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

## Tâches planifiées

Deux tâches tournent en dehors de l'application, sur un socle commun
(`ops/lib/job-runner.sh`) :

| Tâche | Cadence visée | Rôle |
|---|---|---|
| `ops/expire-listings.sh` | **horaire** | Bascule à `expired` les annonces passé 45 jours (§6.3) |
| `ops/audit-retention.sh` | **hebdomadaire** | Archive puis purge le journal d'audit, et vérifie l'archive |

Aucun ordonnanceur n'est fourni : les deux tâches s'exécutent à la demande, ou
depuis l'ordonnanceur de votre choix (unité systemd, `/etc/cron.d`,
ordonnanceur de la plateforme d'hébergement). Elles ne supposent rien de leur
appelant — ni répertoire courant, ni `PATH`, ni environnement de shell de
connexion — ce qui est précisément le rôle du socle décrit plus bas.

```bash
npm run listings:expire          # ops/expire-listings.sh
npm run audit:retention          # archive puis purge

npm run listings:expire-check    # simulation, aucune modification
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
  l'exécution précédente fait déjà le travail, ce n'est pas une erreur. Les
  deux tâches ont des verrous distincts et ne se bloquent pas l'une l'autre.
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

Le LCP sur 4G réelle depuis le Cambodge reste à mesurer sur l'hébergement
cible (Singapour) ; les chiffres locaux ne le prédisent pas.

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
  checks/bot-conversation.mjs Conversation complète, sans jeton
  checks/extraction-contract.mjs  Contrat de requête, sans appel
  checks/translation.mjs      Contrat + file de traduction, sans appel
  checks/seo-landing.mjs      Cohérence sitemap ↔ robots, balises, contenu
  checks/view-tracking.mjs    Dédoublonnage, robots, vie privée, cohérence
  fixtures/                   Flux d'exemple XML et CSV
  checks/dedup-merge.mjs      Vérification de la fusion (transaction annulée)
ops/
  lib/job-runner.sh           Socle commun : verrou, environnement, node, journal
  expire-listings.sh          Lanceur — expiration des annonces
  audit-retention.sh          Lanceur — rétention du journal d'audit
messages/                     fr · en · zh · km — 291 clés, parité vérifiée
src/lib/
  search.ts                   Filtres, requêtes, résolution d'alias, fiche bien
  i18n.ts                     Locales, traducteur, négociation, champs JSONB
  map-provider.ts             Couche d'abstraction cartographique
  seo.ts                      Pages d'atterrissage : seuil, stats, maillage
  dashboard.ts                Mesures du tableau de bord agence
  auth.ts                     Mots de passe, sessions, gardes de rôle
  audit.ts                    Écriture du journal, filtres, flux d'export
  format.ts                   USD par défaut, KHR secondaire, fraîcheur
src/components/               Carte, filtres, fiches, badges, pin bloquant
src/app/[locale]/             Accueil · recherche · fiche · agence · connexion · back-office
src/app/api/                  suggest · map · leads · photo · audit/export
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
- **alertes, facturation des abonnements, WeChat** (phase 3) ;
- **gestion des comptes** — l'authentification et le journal d'audit sont en
  place, mais les comptes ne se créent qu'au seed : ni inscription, ni
  réinitialisation de mot de passe, ni second facteur. Les mots de passe du
  seed sont des mots de passe de développement.
- **expiration des annonces** — `expire_stale_listings()` n'est toujours
  déclenchée par rien. Le lanceur `ops/audit-retention.sh` donne le modèle à
  reprendre : même verrou, même résolution de `node`, même journalisation.
- **stockage des archives** — les archives restent sur le disque local, sans
  copie hors site ni chiffrement au repos.
- **médias réels** — les visuels sont générés par `/api/photo/[seed]` ; le
  stockage S3 + CDN avec variantes WebP/AVIF est à brancher.
