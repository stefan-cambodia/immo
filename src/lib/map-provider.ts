// Couche d'abstraction cartographique (§5.4 et risque « coût Google Maps » §11).
// Changer de fournisseur ne doit toucher aucun composant : seules les variables
// NEXT_PUBLIC_MAP_PROVIDER et NEXT_PUBLIC_MAP_API_KEY changent.
//
// Le portail utilise MapLibre GL comme moteur de rendu. Un basculement vers
// Google Maps demanderait un second moteur : `renderer` porte cette information
// pour que la décision reste explicite et localisée ici.

export type MapProviderId = "openfreemap" | "osm" | "maptiler" | "protomaps" | "google";

export interface MapProviderConfig {
  id: MapProviderId;
  renderer: "maplibre" | "google";
  /** Style MapLibre : URL, ou spécification inline pour les fonds raster. */
  style: string | Record<string, unknown>;
  attribution: string;
  maxZoom: number;
}

const OSM_RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
} as const;

const OSM_RASTER: MapProviderConfig = {
  id: "osm", renderer: "maplibre",
  style: OSM_RASTER_STYLE as unknown as Record<string, unknown>,
  attribution: "© OpenStreetMap",
  maxZoom: 19,
};

/**
 * Le fournisseur pour une langue de page.
 *
 * Par défaut, OpenFreeMap : tuiles vectorielles OpenStreetMap, sans clé ni
 * quota, dont les libellés se choisissent par langue
 * (`src/lib/map-labels.ts`). Les tuiles raster d'openstreetmap.org dessinent
 * les noms une fois pour toutes, dans l'écriture locale : une page française
 * ou russe montrait une carte en khmer. Leur politique d'usage exclut en
 * outre une application qui les sert à ses visiteurs.
 *
 * Sauf en khmer. MapLibre ne compose pas les écritures complexes : les
 * voyelles khmères, placées avant ou autour de la consonne, et les
 * consonnes souscrites s'afficheraient dans l'ordre de saisie, illisibles.
 * Les tuiles raster, rendues côté serveur, les composent correctement, et
 * leurs noms sont en khmer — ce que veut un lecteur khmérophone. Les tuiles
 * vectorielles n'ont d'ailleurs pas de champ `name:km`.
 */
export function getMapProvider(locale?: string): MapProviderConfig {
  const id = (process.env.NEXT_PUBLIC_MAP_PROVIDER ?? "openfreemap") as MapProviderId;
  const key = process.env.NEXT_PUBLIC_MAP_API_KEY ?? "";

  switch (id) {
    case "maptiler":
      return {
        id, renderer: "maplibre",
        style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${key}`,
        attribution: "© MapTiler © OpenStreetMap",
        maxZoom: 20,
      };
    case "protomaps":
      return {
        id, renderer: "maplibre",
        style: `https://api.protomaps.com/styles/v4/light/en.json?key=${key}`,
        attribution: "© Protomaps © OpenStreetMap",
        maxZoom: 20,
      };
    case "google":
      // Couverture cambodgienne supérieure, coût nettement plus élevé à
      // l'échelle. À arbitrer sur le volume projeté (§13, décision 1).
      return {
        id, renderer: "google",
        style: "google:roadmap",
        attribution: "© Google",
        maxZoom: 21,
      };
    case "osm":
      return OSM_RASTER;
    case "openfreemap":
    default:
      if (locale === "km") return OSM_RASTER;
      return {
        id: "openfreemap", renderer: "maplibre",
        style: "https://tiles.openfreemap.org/styles/liberty",
        // Les tuiles déclarent elles-mêmes « OpenFreeMap © OpenMapTiles,
        // données OpenStreetMap » : rien à ajouter.
        attribution: "",
        maxZoom: 19,
      };
  }
}

/** Cadrage par défaut : le Cambodge entier. */
export const CAMBODIA_BOUNDS: [[number, number], [number, number]] = [
  [102.3, 9.9], [107.7, 14.7],
];
export const PHNOM_PENH: { center: [number, number]; zoom: number } = {
  center: [104.916, 11.5564], zoom: 12,
};
