/**
 * Libellés du fond de carte dans la langue de la page.
 *
 * Un style vectoriel OpenMapTiles écrit ses noms en latin suivi de
 * l'écriture locale (« Phnom Penh ភ្នំពេញ »), quelle que soit la page.
 * Avant de le donner à MapLibre, on remplace l'expression de chaque libellé
 * de lieu par une cascade : le nom dans la langue de la page, puis
 * l'anglais, puis la forme latine, puis le nom local. Les cartouches de
 * routes (`ref`) ne sont pas touchés.
 *
 * Pas de cascade pour le khmer : son fond est raster (voir map-provider.ts).
 * Un style raster, ou un style qu'on n'arrive pas à lire, est rendu tel
 * quel — MapLibre le chargera lui-même et signalera l'échec s'il y en a un.
 */
const CHAINS: Record<string, string[]> = {
  en: ["name:en", "name_en"],
  fr: ["name:fr", "name:en", "name_en"],
  ru: ["name:ru", "name:en", "name_en"],
  zh: ["name:zh-Hans", "name:zh", "name:en", "name_en"],
};

type Style = string | Record<string, unknown>;
type Layer = { layout?: Record<string, unknown> };

export async function localizedStyle(style: Style, lang: string): Promise<Style> {
  const chain = CHAINS[lang];
  if (typeof style !== "string" || !chain) return style;
  try {
    const res = await fetch(style);
    if (!res.ok) return style;
    const json = await res.json() as { layers?: Layer[] };
    const label = ["coalesce", ...chain.map((k) => ["get", k]), ["get", "name:latin"], ["get", "name"]];
    for (const layer of json.layers ?? []) {
      const field = layer.layout?.["text-field"];
      if (field !== undefined && JSON.stringify(field).includes('"name')) {
        layer.layout!["text-field"] = label;
      }
    }
    return json;
  } catch {
    return style;
  }
}
