# Portail immobilier Cambodge — Brief projet & roadmap

> Document de référence. À utiliser comme instructions permanentes du projet.
> Toute décision technique ou produit doit être cohérente avec les principes de la section 2.

---

## 1. Contexte et objectif

### 1.1 Le produit

Portail de recherche immobilière couvrant l'ensemble du Cambodge (vente et location), destiné à trois audiences distinctes :

| Audience | Langue | Recherche | Contrainte spécifique |
|---|---|---|---|
| Expatriés et investisseurs occidentaux | FR / EN | Condos, villas en location longue durée, investissement locatif | Ne peuvent pas acheter de terrain ni de rez-de-chaussée |
| Investisseurs chinois | 简体中文 | Condos neufs, Sihanoukville, Phnom Penh | N'utilisent ni Google ni Facebook — canal WeChat |
| Marché domestique khmer | ខ្មែរ | Borey, terrains, flats, locaux commerciaux | Mobile Android bas de gamme, données coûteuses |

### 1.2 Le problème du marché

Le marché immobilier cambodgien n'a **pas de MLS**, pas de base partagée, pas d'exclusivité contractuelle. Conséquences observables :

- Un même bien est publié par 5 à 10 agences, à des prix différents, avec des jeux de photos différents.
- Les portails existants conservent en ligne des annonces vendues depuis plus d'un an.
- Les adresses ne sont pas fiables : numérotation incohérente, rues sans nom officiel, géocodage automatique faux hors centre-ville.
- Les agents travaillent depuis Telegram et Messenger sur téléphone, pas depuis un back-office web.

### 1.3 La proposition de valeur

**Un bien = une fiche.** Le portail déduplique les annonces multiples et affiche une fiche unique par bien physique, avec la liste des agences qui le proposent et leurs prix respectifs. Aucun acteur local ne le fait proprement.

Second différenciateur : **la fraîcheur vérifiée**. Chaque fiche affiche publiquement sa date de dernière confirmation par l'agent.

Troisième différenciateur : **le filtre « éligible étranger »**, qui applique automatiquement les règles de propriété cambodgiennes.

---

## 2. Principes directeurs (décisions verrouillées)

Ces points ne sont pas à rediscuter sans raison forte. Ils conditionnent l'architecture.

1. **Séparation stricte `Property` / `Listing`.** Le bien physique et l'annonce commerciale sont deux entités distinctes. Toute la valeur du produit en découle.
2. **Le pin de la carte est posé à la main.** Jamais de géocodage automatique depuis une adresse texte. Étape bloquante à la saisie.
3. **Le contenu est structuré au maximum.** Plus de champs typés = moins de texte libre à traduire en 4 langues.
4. **Mobile-first, réseau contraint.** Cible : page de résultats utilisable en moins de 3 s sur 4G moyenne, sur Android d'entrée de gamme.
5. **Rendu serveur obligatoire.** Le SEO multilingue est un canal d'acquisition majeur — pas de SPA côté client seul.
6. **USD par défaut.** KHR en affichage secondaire. Le dollar domine les transactions.
7. **Le khmer est testé en premier, pas en dernier.** Toute maquette validée doit l'être en khmer.
8. **Aucune fonctionnalité de v1 ne dépend d'un partenariat non signé.**

---

## 3. Modèle de données

### 3.1 Entités principales

```
Property (bien physique)
├── id
├── building_id           → FK Building, nullable (condos et immeubles)
├── property_type         → enum, cf. §5.1
├── location_id           → FK Location
├── geo_point             → PostGIS POINT(4326), saisi manuellement
├── floor                 → int, nullable
├── unit_number           → string, nullable
├── bedrooms / bathrooms  → int
├── indoor_area_sqm       → decimal
├── land_area_sqm         → decimal, nullable
├── title_type            → enum: hard | soft | strata | unknown
├── foreign_eligible      → bool, calculé (cf. §5.3)
├── year_built            → int, nullable
├── dedup_signature       → string, indexé
└── verified_at           → timestamp, nullable

Listing (annonce d'une agence sur un bien)
├── id
├── property_id           → FK Property
├── agency_id             → FK Agency
├── agent_id              → FK Agent
├── transaction_type      → enum: sale | rent
├── price_usd             → decimal
├── price_period          → enum: total | monthly (location)
├── negotiable            → bool
├── status                → enum: active | pending | expired | sold | rejected
├── source                → enum: telegram_bot | xml_feed | csv | backoffice
├── expires_at            → timestamp (45 j par défaut)
├── last_confirmed_at     → timestamp
├── description_i18n      → JSONB { fr, en, zh, km }
├── description_source_lang → enum
└── created_at / updated_at

PriceHistory
├── listing_id, price_usd, recorded_at
```

### 3.2 Entités support

```
Location (hiérarchie administrative)
├── id, parent_id         → arbre : province > district > commune
├── level                 → enum: province | district | commune | neighborhood
├── name_i18n             → JSONB { fr, en, zh, km }
├── aliases[]             → array, cf. §5.2 — CRITIQUE
├── boundary              → PostGIS POLYGON, nullable
└── geo_center            → PostGIS POINT

Building (immeubles et boreys nommés)
├── id, name_i18n, developer_id, location_id, geo_point
├── total_floors, total_units, completion_year, status
└── amenities[]

Agency / Agent
├── verification_status   → unverified | documents_received | verified
├── subscription_tier     → free | standard | premium
└── listing_quota

Media
├── property_id / listing_id
├── perceptual_hash       → détection de réutilisation, cf. §6.2
└── variants[]            → tailles générées

Lead
├── listing_id, agent_id, channel, locale, action_type, created_at
    → indispensable dès la v1 pour facturer et prouver la valeur
```

### 3.3 Règle d'affichage

L'utilisateur voit une **fiche `Property`**, jamais une liste de `Listing`. La fiche affiche : « 5 agences proposent ce bien, de 145 000 $ à 162 000 $ ».

---

## 4. Internationalisation

### 4.1 Trois chantiers distincts

**Interface** — fichiers de traduction classiques. URLs préfixées : `/fr/`, `/en/`, `/zh/`, `/km/`. Balises `hreflang` complètes + `x-default`.

**Contenu des annonces** — l'agent saisit dans **une seule langue**. Le système :
- stocke la langue source,
- génère les traductions automatiquement à l'ingestion (pas à l'affichage — coût et latence),
- marque visuellement les traductions machine,
- fait relire humainement uniquement les annonces premium.

**Champs structurés** — traduits une fois pour toutes via les tables de référence (types de biens, équipements, quartiers). Aucun coût de traduction récurrent.

### 4.2 Typographie khmère — points de vigilance

- Le khmer **ne sépare pas les mots par des espaces** → les retours à la ligne CSS par défaut cassent le texte. Utiliser `word-break` adapté et tester.
- Les signes diacritiques débordent verticalement → `line-height` majoré d'environ 1,6 à 1,8.
- Le texte khmer occupe **30 à 40 % de place en plus** que l'anglais → toute maquette à largeur fixe est à revoir.
- Polices : Noto Sans Khmer ou Kantumruy Pro, sous-ensembles chargés séparément.

### 4.3 Chinois — canal spécifique

Le chinois simplifié (简体) est requis, mais **la version chinoise du site ne suffira pas** : cette audience ne passe pas par Google. Le référencement utile passe par Baidu, WeChat et Xiaohongshu.

→ Un mini-programme WeChat est à évaluer en phase 3, potentiellement plus rentable que l'optimisation du site chinois.

---

## 5. Recherche

### 5.1 Taxonomie des types de biens

Ne pas reprendre une nomenclature occidentale. Taxonomie minimale :

- **Condo** (unité en copropriété)
- **Borey** (lotissement fermé — catégorie majeure au Cambodge)
- **Villa** → sous-types locaux : twin villa, link villa, queen villa, king villa
- **Flat / Shophouse** (maison de ville sur plusieurs niveaux, rez-de-chaussée commercial)
- **Terrain** (résidentiel, agricole, commercial)
- **Local commercial / bureau**
- **Entrepôt / industriel**
- **Immeuble entier**

### 5.2 Alias de romanisation — point critique

Sans table d'alias, environ un tiers des recherches textuelles ne renvoient rien.

Exemples à couvrir dès la v1 :
- Sihanoukville / Preah Sihanouk / Kampong Som / 西哈努克
- Siem Reap / Siemreap / Siemréab / សៀមរាប
- Phnom Penh / Phnum Pénh / ភ្នំពេញ / 金边
- BKK1 / Boeung Keng Kang 1 / BKK One
- Toul Kork / Tuol Kouk / TK

Chaque `Location` porte un tableau `aliases[]` alimenté manuellement puis enrichi par les logs de recherche infructueuse.

### 5.3 Filtre « éligible étranger »

Règle appliquée automatiquement : un étranger ne peut posséder ni terrain, ni rez-de-chaussée. Uniquement des unités en **strata title** à partir du 1er étage.

```
foreign_eligible = (title_type == 'strata') AND (floor >= 1)
```

Ce filtre à lui seul justifie le site pour une part importante de l'audience. À exposer en évidence, pas caché dans les filtres avancés.

### 5.4 Recherche par carte

- Clustering des marqueurs (Phnom Penh sature immédiatement sans cela).
- Comportement « rechercher dans cette zone » au déplacement de la carte.
- **Dessin de polygone** : les acheteurs raisonnent en « autour de BKK1 », pas en rayon kilométrique.
- Google Maps a une meilleure couverture cambodgienne qu'OpenStreetMap mais coûte nettement plus cher à l'échelle. Décision à arbitrer selon le volume projeté — prévoir une couche d'abstraction pour pouvoir basculer.

### 5.5 Filtres à exposer

Prix (USD), type de bien, chambres, salles de bain, surface, étage, **type de titre**, **éligible étranger**, meublé, équipements, date de dernière vérification, promoteur/immeuble.

---

## 6. Ingestion des annonces

### 6.1 Canaux, par ordre d'adoption probable

**1. Bot Telegram — canal déterminant du volume.**
L'agent envoie photos + texte ou message vocal. Un LLM extrait les champs structurés. Le bot renvoie une fiche à confirmer, puis demande le pin sur la carte. C'est le canal qui correspond aux habitudes réelles du terrain.

**2. Import XML / CSV** — pour les agences disposant d'un CRM (IPS, Century 21, Keller Williams).

**3. Back-office web** — corrections, comptes premium, modération. Ne sera pas le canal principal de saisie.

Dans les trois cas : le pin est posé manuellement, étape bloquante.

### 6.2 Déduplication

Signature composite : `building_id + floor + indoor_area_sqm + bedrooms`, complétée par un **hash perceptuel des photos** — les agences se repiquent les images entre elles, ce qui est ici un signal exploitable.

Trois niveaux :
- Correspondance forte → fusion automatique.
- Correspondance partielle → file de validation manuelle.
- Pas de correspondance → nouveau `Property`.

Ne jamais laisser l'algorithme fusionner seul les cas ambigus.

### 6.3 Fraîcheur

- Expiration automatique des `Listing` à **45 jours**.
- Relance de l'agent par Telegram à J-7 : bouton « toujours disponible ? » en un clic.
- Date de dernière confirmation **affichée publiquement** sur la fiche.
- Historique de prix visible — les prix bougent beaucoup et les acheteurs négocient.
- Détection de photos réutilisées entre annonces non liées → signalement modération.

---

## 7. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Frontend / SSR | Next.js (App Router) | SEO multilingue indispensable, i18n natif |
| Base de données | PostgreSQL + PostGIS | Requêtes spatiales, polygones, JSONB pour i18n |
| Moteur de recherche | Meilisearch ou Typesense | Multilingue, tolérance aux fautes, alias — Elasticsearch surdimensionné à ce stade |
| Cache / files | Redis | Sessions, files d'ingestion, rate limiting |
| Médias | S3-compatible + CDN | WebP/AVIF, variantes multiples |
| Bot | Telegram Bot API + worker | Ingestion principale |
| Hébergement | Singapour | Latence vers le Cambodge |

**Performance — budget à respecter :**
- LCP < 2,5 s sur 4G moyenne
- Images en WebP/AVIF, plusieurs tailles, `lazy` agressif sur la carte
- Bundle JS initial < 200 ko gzippé
- Polices khmères et chinoises en sous-ensembles, `font-display: swap`

---

## 8. Monétisation

Le portail ne prend pas de commission sur les transactions (2–3 % côté vendeur, non régulé, hors périmètre).

Sources de revenus, par maturité :

1. **Abonnements agences** — paliers par nombre d'annonces actives.
2. **Mise en avant payante** — top de liste, badge, carrousel d'accueil.
3. **Leads qualifiés vendus aux promoteurs de condos** — segment au plus gros budget marketing, en particulier ceux qui ciblent les acheteurs chinois.

Le tracking des leads doit exister **dès la v1** : qui a cliqué sur quel numéro, sur quel bien, depuis quelle langue, à quelle heure. Sans cela, rien n'est facturable ni démontrable.

---

## 9. Roadmap

### Phase 0 — Cadrage (2–3 semaines)

- Schéma de données finalisé et validé
- Import de la hiérarchie administrative complète (provinces, districts, communes) + quartiers de Phnom Penh
- Constitution de la table d'alias initiale (~300 entrées)
- Maquettes des 5 écrans clés, **testées en khmer et en chinois**
- Arbitrage Google Maps vs alternative, avec projection de coût
- Sélection de 3 à 5 agences pilotes

**Sortie de phase :** schéma gelé, maquettes validées en 4 langues.

---

### Phase 1 — MVP consultable (6–8 semaines)

Objectif : un site public exploitable, alimenté manuellement.

- Recherche par ville et par type de bien
- Carte avec clustering et « rechercher dans cette zone »
- Fiche bien avec listings multiples
- Filtres : prix, type, chambres, surface, **type de titre**, **éligible étranger**
- FR + EN complets, KM + ZH sur l'interface
- Back-office de saisie et modération
- Tracking des leads
- Saisie manuelle de 300 à 500 biens réels sur Phnom Penh

**Critères de sortie :** 500 biens actifs, LCP < 3 s sur 4G, 0 annonce sans pin manuel.

---

### Phase 2 — Ingestion à l'échelle (6–8 semaines)

Objectif : l'offre s'alimente sans intervention interne.

- Bot Telegram avec extraction LLM et confirmation
- Moteur de déduplication + file de validation
- Import XML/CSV pour agences équipées
- Cycle d'expiration 45 j + relances automatiques
- Traduction automatique du contenu à l'ingestion
- Hash perceptuel des photos
- Historique de prix
- Dessin de polygone sur la carte
- Extension à Siem Reap, Sihanoukville, Kampot, Battambang

**Critères de sortie :** 3 000 biens actifs, > 60 % des nouvelles annonces via bot, taux de doublons résiduels < 5 %.

---

### Phase 3 — Acquisition et revenus (8–10 semaines)

- Pages SEO par quartier × type de bien × langue
- Alertes email et Telegram sur critères sauvegardés
- Facturation des abonnements agences, gestion des quotas
- Mise en avant payante
- Tableau de bord agence (vues, leads, performance)
- Vérification des agences (badge)
- **Évaluation du mini-programme WeChat** et présence Xiaohongshu
- Pages promoteurs / projets neufs

**Critères de sortie :** premiers revenus récurrents, 10 agences payantes.

---

### Phase 4 — Différenciation (continu)

- Estimation de prix par quartier à partir de l'historique
- Comparateur de biens
- Rendement locatif estimé (pour les investisseurs)
- Vérification documentaire des titres en partenariat
- Application mobile si les données d'usage la justifient
- Ouverture d'une API pour partenaires

---

## 10. Indicateurs à suivre

| Catégorie | Indicateur | Cible fin phase 2 |
|---|---|---|
| Offre | Biens actifs | 3 000 |
| Offre | Part d'annonces confirmées < 30 j | > 70 % |
| Qualité | Doublons résiduels | < 5 % |
| Qualité | Recherches sans résultat | < 8 % |
| Ingestion | Part via bot Telegram | > 60 % |
| Usage | Leads / 1 000 sessions | à établir en phase 1 |
| Technique | LCP p75 mobile | < 3 s |
| Langues | Répartition du trafic par locale | à suivre, pilote les priorités |

Le taux de **recherches sans résultat** est le meilleur indicateur de santé de la table d'alias. À monitorer en continu et à traiter manuellement chaque semaine.

---

## 11. Risques principaux

| Risque | Impact | Mitigation |
|---|---|---|
| Les agences ne fournissent pas d'annonces | Fatal | Bot Telegram prioritaire ; démarrage avec saisie interne pour créer la masse critique |
| Coût Google Maps à l'échelle | Élevé | Couche d'abstraction dès la v1 pour permettre le basculement |
| Déduplication trop agressive → fusions erronées | Confiance | File de validation manuelle, jamais de fusion auto sur cas ambigu |
| Qualité des traductions machine en khmer | Moyen | Marquage visuel, relecture sur premium, priorité aux champs structurés |
| Audience chinoise inatteignable via le site | Moyen | Canal WeChat évalué en phase 3, pas de dépendance en v1 |
| Annonces frauduleuses / photos volées | Confiance | Hash perceptuel, vérification agence, signalement utilisateur |

---

## 12. Glossaire

| Terme | Signification |
|---|---|
| **Borey** | Lotissement résidentiel fermé, souvent avec sécurité et équipements communs. Catégorie de bien majeure au Cambodge. |
| **Hard title** | Titre de propriété enregistré au niveau national. Plus sûr, bancable. |
| **Soft title** | Titre reconnu au niveau local uniquement. Très répandu, moins sûr juridiquement. |
| **Strata title** | Titre de copropriété. Seul régime permettant la propriété étrangère. |
| **Khan** | District urbain. |
| **Srok** | District rural. |
| **Sangkat** | Commune urbaine. |
| **Flat** | Maison de ville étroite sur plusieurs niveaux, typologie khmère courante. |
| **BKK1** | Boeung Keng Kang 1, quartier central de Phnom Penh très prisé des expatriés. |

---

## 13. Décisions restant à prendre

Ces points ne bloquent pas le démarrage de la phase 0 mais doivent être tranchés avant la phase 1 :

1. Fournisseur de cartographie (Google Maps vs Mapbox vs MapTiler) — arbitrage coût / couverture.
2. Périmètre géographique de la v1 : Phnom Penh seul, ou Phnom Penh + Siem Reap + Sihanoukville.
3. Location incluse dès la v1 ou vente seulement.
4. Modèle de traduction automatique retenu et budget associé.
5. Politique d'accès aux annonces : tout public, ou coordonnées agent derrière un formulaire.
