# API partenaires — contrat v1

> Phase 4 du brief : « ouverture d'une API pour partenaires ».
> Lecture seule. La saisie d'annonces reste sur les canaux d'ingestion (§6.1) :
> bot Telegram, flux XML/CSV, back-office — eux seuls portent le pin manuel
> et la déduplication.

## Ce que l'API distribue — et ce qu'elle ne distribue pas

L'API sert la donnée qui fait la valeur du portail : la **fiche `Property`
dédupliquée** (§3.3), avec ses offres agrégées par agence. Elle ne sert
jamais :

- **les coordonnées des agents** (téléphone, Telegram, WeChat) — le contact
  est l'événement facturable du portail (§8), il ne sort pas en gros ;
- **des `Listing` isolés** — l'unité servie est le bien physique, ses
  annonces n'apparaissent que rattachées à leur fiche ;
- **les leads, les données d'audience, le journal d'audit** — données
  internes.

## Authentification

Chaque partenaire reçoit une ou plusieurs clés, émises depuis le back-office
et **affichées une seule fois**. La base ne conserve que leur hachage : une
clé perdue se remplace, elle ne se retrouve pas.

La clé passe par l'en-tête — jamais par l'URL :

```
Authorization: Bearer ci_…
```

(`X-Api-Key: ci_…` est accepté comme repli pour les clients qui ne peuvent
pas poser d'en-tête `Authorization`.)

| Situation | Réponse |
|---|---|
| En-tête absent ou clé inconnue | `401 { "error": "missing_key" \| "unknown_key" }` |
| Clé révoquée | `403 { "error": "key_revoked" }` |
| Partenaire désactivé | `403 { "error": "partner_inactive" }` |
| Quota journalier épuisé | `429 { "error": "quota_exceeded" }` |
| Paramètre invalide | `400 { "error": "invalid_parameter", "parameter": "…" }` |

## Quota

Chaque clé porte un quota **journalier** (5 000 appels par défaut, ajustable
par clé). Toute réponse porte :

```
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4993
x-ratelimit-reset: 28800        ← secondes avant la remise à zéro (minuit UTC)
```

Les appels refusés à 429 restent comptés.

## Endpoints

### `GET /api/partner/v1/properties`

Fiches agrégées, triées par référence, paginées par curseur.

| Paramètre | Type | Note |
|---|---|---|
| `transaction` | `sale` \| `rent` | ne garde que les biens ayant une offre active de ce type |
| `type` | répétable | `condo`, `borey_house`, `villa`, `flat_shophouse`, `land`, `commercial`, `warehouse`, `whole_building` |
| `location` | slug | descente hiérarchique : `phnom-penh` englobe tous ses khan et sangkat |
| `foreign_eligible` | `1` | applique la règle §5.3 (strata + étage ≥ 1) |
| `price_min` / `price_max` | USD | exigent `transaction` ; portent sur le meilleur prix affiché de l'offre |
| `updated_since` | ISO 8601 | biens dont la fiche **ou une annonce** a bougé depuis — c'est le paramètre des synchronisations |
| `limit` | 1–100, défaut 50 | |
| `cursor` | référence | valeur `next_cursor` de la page précédente |

```json
{
  "data": [
    {
      "reference": "PP-4F2A19",
      "property_type": "condo",
      "villa_subtype": null,
      "floor": 12, "bedrooms": 2, "bathrooms": 2,
      "indoor_area_sqm": 78.5, "land_area_sqm": null,
      "title_type": "strata", "foreign_eligible": true,
      "furnished": true, "year_built": 2021,
      "amenities": ["pool", "gym"],
      "geo": { "lng": 104.922, "lat": 11.556 },
      "location": { "slug": "bkk1", "level": "neighborhood",
                    "name": { "fr": "…", "en": "…", "zh": "…", "km": "…" },
                    "parent": { "slug": "chamkarmon", "name": { … } } },
      "building": { "slug": "…", "name": { … } },
      "title_verified": { "at": "2026-08-12T04:10:00Z", "by": "BNG Legal" },
      "offers": [
        { "transaction_type": "sale", "listing_count": 3, "agency_count": 3,
          "price_min_usd": 145000, "price_max_usd": 162000,
          "last_confirmed_at": "2026-08-20T09:31:00Z" }
      ],
      "updated_at": "2026-08-20T09:31:00Z"
    }
  ],
  "next_cursor": "PP-4F2A19"
}
```

La pagination par curseur est stable sous insertions : reprendre avec
`cursor=<next_cursor>` jusqu'à `next_cursor: null`.

### `GET /api/partner/v1/properties/{reference}`

La même fiche, complétée par :

- `listings[]` — les annonces actives : `transaction_type`, `price_usd`,
  `price_period`, `negotiable`, `last_confirmed_at`, `description`
  (les 4 langues), `description_source_lang`, `machine_translated`, et
  l'`agency` (slug, nom, statut de vérification). Pas d'agent.
- `media[]` — `url`, `width`, `height`, dans l'ordre éditorial.

`404 { "error": "not_found" }` pour une référence inconnue.

### `GET /api/partner/v1/locations`

Le référentiel des localités : hiérarchie administrative complète
(`slug`, `level`, `parent_slug`), noms en 4 langues, **alias de
romanisation** (§5.2), centre géographique et nombre d'annonces. C'est la
table de correspondance à utiliser pour mapper des libellés libres
(« Kampong Som », « 西哈努克 ») vers les slugs du portail.

## Versionnement

Le contrat est versionné dans l'URL (`/v1/`). Dans une même version, le
contrat n'évolue **que par ajout de champs** — jamais par retrait, renommage
ou changement de type. Un client doit donc ignorer les champs qu'il ne
connaît pas.

## Exemple

```sh
curl -s "https://khmerestate.kh/api/partner/v1/properties?location=bkk1&transaction=sale&foreign_eligible=1&limit=20" \
  -H "Authorization: Bearer $API_KEY" | jq '.data[].reference'
```
