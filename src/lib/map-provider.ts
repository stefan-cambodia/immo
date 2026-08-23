// Couche d'abstraction cartographique (§5.4 et risque « coût Google Maps » §11).
// Changer de fournisseur ne doit toucher aucun composant : seules les variables
// NEXT_PUBLIC_MAP_PROVIDER et NEXT_PUBLIC_MAP_API_KEY changent.
//
// Le portail utilise MapLibre GL comme moteur de rendu. Un basculement vers
// Google Maps demanderait un second moteur : `renderer` porte cette information
// pour que la décision reste explicite et localisée ici.

export type MapProviderId = "osm" | "maptiler" | "protomaps" | "google";

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

export function getMapProvider(): MapProviderConfig {
  const id = (process.env.NEXT_PUBLIC_MAP_PROVIDER ?? "osm") as MapProviderId;
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
    default:
      return {
        id: "osm", renderer: "maplibre",
        style: OSM_RASTER_STYLE as unknown as Record<string, unknown>,
        attribution: "© OpenStreetMap",
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
