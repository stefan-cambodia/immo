/**
 * Description d'annonce engendrée depuis les champs structurés (§4.1).
 *
 * Le principe n°3 tient en une phrase : ce qui est structuré n'a pas à être
 * traduit. Les quatre langues sortent d'ici sans appel de modèle, et le
 * traducteur automatique n'est sollicité que sur le texte libre — celui qu'une
 * agence a réellement écrit.
 *
 * C'est aussi ce qui rend la collecte de portails tenable : on ne reprend que
 * des faits, et la prose de l'annonce d'origine n'est jamais recopiée.
 */

export const TYPE_LABEL = {
  condo: { fr: "Appartement", en: "Condo", zh: "公寓", km: "ខុនដូ" },
  borey_house: { fr: "Maison en borey", en: "Borey house", zh: "别墅区住宅", km: "ផ្ទះក្នុងបុរី" },
  villa: { fr: "Villa", en: "Villa", zh: "别墅", km: "វីឡា" },
  flat_shophouse: { fr: "Flat / shophouse", en: "Flat / shophouse", zh: "排屋", km: "ផ្ទះល្វែង" },
  land: { fr: "Terrain", en: "Land", zh: "土地", km: "ដីធ្លី" },
  commercial: { fr: "Local commercial", en: "Commercial space", zh: "商铺", km: "អគារពាណិជ្ជកម្ម" },
  warehouse: { fr: "Entrepôt", en: "Warehouse", zh: "仓库", km: "ឃ្លាំង" },
  whole_building: { fr: "Immeuble entier", en: "Whole building", zh: "整栋楼", km: "អគារទាំងមូល" },
};

const VERB = {
  sale: { fr: "à vendre", en: "for sale", zh: "出售", km: "សម្រាប់លក់" },
  rent: { fr: "à louer", en: "for rent", zh: "出租", km: "សម្រាប់ជួល" },
};

/**
 * @param {{property_type: string, bedrooms?: number, indoor_area_sqm?: number|null,
 *          land_area_sqm?: number|null, furnished?: boolean, floor?: number|null}} p
 * @param {{fr: string, en: string, zh: string, km: string}} hoodNames
 * @param {"sale"|"rent"} txn
 */
export function describe(p, hoodNames, txn) {
  const t = TYPE_LABEL[p.property_type];
  const bd = p.bedrooms, ar = p.indoor_area_sqm ?? p.land_area_sqm;
  const verb = VERB[txn];
  return {
    fr: `${t.fr} ${verb.fr} à ${hoodNames.fr}${bd ? `, ${bd} chambre${bd > 1 ? "s" : ""}` : ""}${ar ? `, ${ar} m²` : ""}.${p.furnished ? " Entièrement meublé." : ""}${p.floor ? ` Étage ${p.floor}.` : ""}`,
    en: `${t.en} ${verb.en} in ${hoodNames.en}${bd ? `, ${bd} bedroom${bd > 1 ? "s" : ""}` : ""}${ar ? `, ${ar} sqm` : ""}.${p.furnished ? " Fully furnished." : ""}${p.floor ? ` Floor ${p.floor}.` : ""}`,
    zh: `${hoodNames.zh}${t.zh}${verb.zh}${bd ? `，${bd}房` : ""}${ar ? `，${ar}平方米` : ""}。${p.furnished ? "全装修家具齐全。" : ""}${p.floor ? `${p.floor}层。` : ""}`,
    km: `${t.km}${verb.km}នៅ${hoodNames.km}${bd ? ` បន្ទប់គេង ${bd}` : ""}${ar ? ` ទំហំ ${ar} ម២` : ""}។${p.furnished ? " មានគ្រឿងសង្ហារិមគ្រប់គ្រាន់។" : ""}${p.floor ? ` ជាន់ទី ${p.floor}។` : ""}`,
  };
}
