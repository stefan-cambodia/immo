# Évaluation — application mobile (phase 4)

> Prévu par la roadmap §9 (phase 4) : « Application mobile si les données
> d'usage la justifient. » Ce document instruit la décision ; il ne
> l'exécute pas. Comme pour le mini-programme WeChat, la conclusion tient en
> une phrase : les données d'usage ne la justifient pas encore, et les seuils
> qui la déclencheraient sont définis ci-dessous, mesurables sur
> l'instrumentation déjà en place.

## 1. Pourquoi la question se pose

Le marché cambodgien est mobile d'abord — c'est le principe verrouillé n°4 du
brief : Android d'entrée de gamme, données coûteuses, 4G moyenne. L'audience
khmère consulte depuis le téléphone ou pas du tout. La question n'est donc
pas « nos utilisateurs sont-ils sur mobile ? » (ils le sont), mais : **une
application apporterait-elle quelque chose que le site mobile ne fait pas
déjà ?**

Ce qu'une application apporte en propre se réduit à quatre choses :

1. **Notifications push** — ré-solliciter le visiteur quand un bien
   correspond à ses critères.
2. **Présence sur l'écran d'accueil** — revenir sans repasser par une
   recherche.
3. **Cache hors ligne** — consulter des fiches déjà vues sans données.
4. **Un canal de distribution** (Play Store) — et son référencement propre.

Tout le reste — recherche, carte, fiche, filtres, quatre langues — est déjà
servi par le site, en rendu serveur, sous le budget de performance (§7).

## 2. Les trois options

### A. Application native (ou React Native / Flutter)

**Coûts et réalités :**

| Poste | Réalité |
|---|---|
| Développement | 8 à 12 semaines pour re-livrer ce que le site fait déjà, plus l'infrastructure push. Les API partenaires (phase 4) prouvent que le serveur est prêt ; le coût est entièrement côté client. |
| Deux plateformes | Le marché local est Android d'abord ; iOS ne pèse que sur le segment expatrié. Une seule plateforme au départ, mais le Play Store impose ses propres cycles de revue. |
| Maintenance | Chaque évolution du portail se livre deux fois : le site se déploie en continu, l'application attend sa revue et ses utilisateurs qui ne mettent pas à jour. Le back-office et l'ingestion continuent d'évoluer chaque semaine. |
| Poids | Une application de 20–40 Mo à télécharger est un obstacle réel là où les données sont chères — le public visé est précisément celui qui y est le plus sensible. |
| Découvrabilité | Le SEO multilingue est le canal d'acquisition majeur (principe n°5). Une application n'y contribue pas : elle convertit un trafic existant, elle n'en crée pas. |

### B. PWA — le site installable

Manifeste + service worker : l'écran d'accueil (2), le cache hors ligne (3)
et — sur Android, la plateforme qui compte ici — les notifications push (1),
pour un coût de quelques jours et **zéro seconde de délai de mise à jour**,
puisque c'est le même site. Pas de présence Play Store (4), sauf à empaqueter
la PWA (TWA), ce qui reste possible plus tard sans rien réécrire.

### C. Statu quo instrumenté — Telegram comme couche applicative

Le portail a déjà un canal de ré-sollicitation : les **alertes Telegram sur
critères sauvegardés** (phase 3, `saved_searches.channel = 'telegram'`).
Au Cambodge, Telegram est installé, gratuit en données chez plusieurs
opérateurs, et c'est là que les agents travaillent déjà (§6.1). Une alerte
Telegram **est** une notification push — sans application à construire, sans
revue de store, sans poids à télécharger.

## 3. Ce que disent nos données

L'instrumentation nécessaire existe depuis les phases 1 et 3 ; aucun
développement n'est requis pour instruire la décision, seulement du trafic
réel :

- **Part mobile des contacts** — `leads.user_agent` est stocké depuis la
  v1 ; la part des leads émis depuis un mobile est mesurable immédiatement.
- **Récurrence** — `property_views(session_id, created_at)` donne la part
  des sessions qui reviennent d'un jour à l'autre : c'est LA donnée qui
  justifie une présence sur l'écran d'accueil. Un visiteur qui vient une
  fois pour une recherche ponctuelle n'installe rien.
- **Appétit pour la ré-sollicitation** — le nombre d'alertes actives et la
  part du canal Telegram (`saved_searches`) mesurent ce que vaudrait le
  push : des visiteurs qui ne sauvegardent pas de recherche ne veulent pas
  être notifiés, application ou pas.

Une lacune connue : `property_views` ne porte pas la classe d'appareil (la
table ne stocke volontairement ni IP ni user-agent). Le jour où l'instruction
démarre, ajouter une colonne `device` (`mobile` / `desktop`, dérivée du
user-agent à l'écriture, sans le conserver) reste cohérent avec cette
position et donne le dénominateur côté vues.

Seuils proposés (fenêtre de 90 jours glissants, une fois le site lancé) :

- **Palier B (PWA)** — dès que le trafic est réel et récurrent :
  plus de 10 000 sessions/mois **et** plus de 20 % de sessions récurrentes
  sous 30 jours. En dessous, il n'y a personne à installer.
- **Palier A (native)** — seulement si, la PWA en place : plus de 1 000
  alertes actives, une part Telegram/push > 50 % de ces alertes, **et** un
  besoin avéré que la PWA ne couvre pas (push iOS significatif côté
  expatriés, ou exigence d'un partenaire — promoteur voulant une marque
  blanche, par exemple).

## 4. Recommandation

**Ne pas construire d'application native maintenant.** Trois raisons :

1. **Le site est déjà l'application mobile** — mobile-first sous budget de
   performance, c'est le produit lui-même (principe n°4), pas un dérivé.
2. **Le seul apport décisif du natif — le push — est déjà servi** par les
   alertes Telegram, dans l'outil que le terrain utilise déjà, et le sera par
   la PWA sur Android le jour venu.
3. **Le coût est récurrent, pas ponctuel** — chaque semaine de développement
   du portail devrait ensuite se livrer deux fois. À ce stade, ces semaines
   valent plus sur l'offre (biens actifs, fraîcheur, alias) : c'est elle qui
   conditionne tous les indicateurs de la §10.

**Décision proposée :** réévaluer chaque trimestre sur les trois mesures de
la §3 (part mobile des leads, sessions récurrentes, alertes actives par
canal). Déclencher B (PWA) au premier seuil atteint ; n'instruire A que si
les conditions du second palier sont réunies **et** qu'un cas d'usage
concret reste hors de portée de la PWA.

## 5. Ce qui est prêt le jour où le palier se déclenche

- **Les API sont là** : l'API partenaires (phase 4) sert déjà fiches
  agrégées, localités et filtres en JSON versionné — une application, PWA
  empaquetée ou native, est un client de plus, comme le mini-programme
  WeChat le serait.
- **Le tracking suivra sans travaux** : `leads.channel` et
  `property_views` sont indépendants du client ; l'apport de l'application
  sera mesurable — donc comparable à son coût — dès le premier jour.
- **Le budget de performance a déjà payé le plus dur** : polices en
  sous-ensembles, images en variantes, bundle initial contenu — la PWA
  hérite de tout.
