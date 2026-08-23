# Évaluation — mini-programme WeChat et présence Xiaohongshu (phase 3)

> Prévu par la roadmap §4.3 et §9 (phase 3) : « Un mini-programme WeChat est à
> évaluer en phase 3, potentiellement plus rentable que l'optimisation du site
> chinois. » Ce document instruit la décision ; il ne l'exécute pas.

## 1. Pourquoi la question se pose

L'audience chinoise (investisseurs en condos neufs, Phnom Penh et
Sihanoukville) n'utilise ni Google ni Facebook. La version `/zh/` du site,
aussi soignée soit-elle, est invisible depuis la Chine continentale :

- **Google est bloqué** — le SEO multilingue, principal canal d'acquisition du
  portail, n'atteint pas cette audience.
- **Baidu indexe mal les sites hors de Chine** — sans ICP (licence
  d'hébergement chinoise), un site étranger est relégué ; l'ICP exige une
  entité juridique chinoise.
- **La recherche immobilière chinoise se fait dans WeChat et Xiaohongshu**,
  pas dans un navigateur.

Le segment pèse lourd dans le modèle de revenus : les promoteurs de condos qui
ciblent les acheteurs chinois sont le troisième pilier (« leads qualifiés
vendus aux promoteurs », roadmap §8), avec le plus gros budget marketing.

## 2. Les trois options

### A. Mini-programme WeChat

Application légère qui vit dans WeChat (WXML/WXSS ou framework type Taro
réutilisant du React). Réutiliserait nos API existantes : recherche,
suggestions, fiches biens, tracking des leads — le travail serveur est déjà
fait.

**Bloquants et coûts :**

| Poste | Réalité |
|---|---|
| Compte développeur | Vérification d'entité requise. Une société **non chinoise** peut s'enregistrer (~99 USD/an), mais la procédure passe par un agent agréé et prend des semaines. |
| Catégorie « immobilier » | Soumise à autorisation ; pour une entité étrangère, la catégorie exige des licences difficiles à produire. Risque réel de refus ou de retrait à la première revue. |
| Paiements WeChat Pay | Hors de portée sans entité chinoise — acceptable, le portail ne vend rien aux visiteurs. |
| Développement | 4 à 8 semaines en réutilisant les API ; maintenance continue (revues WeChat fréquentes, breaking changes du runtime). |
| Découvrabilité | Un mini-programme **n'a pas de trafic organique propre** : il se découvre par partage, QR code ou compte officiel. Sans stratégie de contenu en amont, c'est une application vide. |

### B. Compte officiel WeChat (公众号) — palier intermédiaire

Compte de contenu (articles, fiches de biens sélectionnées, QR sur les
supports des agences partenaires). Enregistrable par une entité étrangère via
agent, sans la catégorie réglementée « transaction immobilière » puisqu'on ne
fait que publier. C'est aussi le **prérequis de découvrabilité** du
mini-programme : les deux se lient.

### C. Présence Xiaohongshu (小红书)

Réseau de recommandation où se documentent précisément les acheteurs
immobiliers à l'étranger. Un compte de marque + publications régulières
(quartiers, prix médians, guides d'achat pour étrangers — contenu que nos
pages SEO produisent déjà en `/zh/`). Coût marginal : traduction/adaptation
du contenu existant, pas de développement.

## 3. Ce que disent nos données

Le portail mesure depuis la phase 3 la répartition par langue des vues et des
leads (`property_views.locale`, `leads.locale`, tableau de bord agence). C'est
l'instrument de décision : la part `zh` des leads est le signal d'une demande
chinoise réelle atteignant le site **malgré** l'absence de canal dédié —
chaque lead `zh` actuel a franchi un parcours défavorable.

Seuils proposés (part `zh` des leads sur 90 jours glissants) :

- **< 5 %** — le canal chinois ne justifie encore aucun investissement dédié ;
  la version `/zh/` suffit.
- **5–15 %** — lancer B + C (compte officiel + Xiaohongshu) : coût faible,
  réutilise le contenu, construit l'audience qui rendrait un mini-programme
  utile.
- **> 15 % soutenu, ou premier contrat promoteur ciblant les acheteurs
  chinois** — instruire le mini-programme (A), avec l'entité et l'agent
  d'enregistrement choisis à ce moment-là.

## 4. Recommandation

**Ne pas construire le mini-programme maintenant.** Trois raisons :

1. **Découvrabilité inversée** — un mini-programme sans compte officiel ni
   audience Xiaohongshu ne serait trouvé par personne. Les paliers B et C
   doivent précéder A, quoi qu'il arrive.
2. **Risque réglementaire** — la catégorie immobilière pour une entité
   étrangère est le point dur ; l'instruire avant d'avoir la preuve de la
   demande, c'est payer le risque avant le revenu.
3. **Coût d'opportunité** — 4 à 8 semaines de développement valent plus sur
   l'estimation de prix par quartier (phase 4), qui sert toutes les langues.

**Décision proposée :** ouvrir B + C dès que la part `zh` des leads dépasse
5 % sur 90 jours (mesurable dans le tableau de bord), avec un budget contenu
de quelques heures par semaine. Réévaluer A à chaque trimestre sur les seuils
ci-dessus. Les QR codes des supports agences pointent vers `/zh/` en
attendant, ce qui rend le trafic WeChat → site mesurable via `?utm=wechat`
(déjà capté par `trafficSources`).

## 5. Ce qui est prêt le jour où A se déclenche

- Les API publiques (recherche, suggestion, fiches, leads) sont
  indépendantes du rendu — un mini-programme est un client de plus.
- Le contenu `/zh/` est complet (traduction à l'ingestion, §4.1) et les pages
  SEO par quartier fournissent la matière éditoriale de B et C.
- Le tracking des leads porte déjà la locale et le canal : l'apport du canal
  WeChat sera mesurable dès le premier jour, donc facturable aux promoteurs.
