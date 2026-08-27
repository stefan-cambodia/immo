/**
 * Collecte des annonces publiées sur les portails immobiliers (§6.1, canal 4).
 *
 * Ce module ne fait qu'UNE chose : lire des pages publiques et en extraire des
 * faits. Il ne décide de rien — c'est l'entonnoir commun (db/lib/ingest.mjs)
 * qui range les annonces, exactement comme pour un flux CRM ou le bot.
 *
 * Ce qui est repris, et ce qui ne l'est pas
 * ----------------------------------------
 * REPRIS   : prix, transaction, type de bien, chambres, salles d'eau,
 *            surfaces, étage, commune, coordonnées, référence de l'annonce,
 *            URL d'origine, et l'ADRESSE des photographies de l'annonce.
 * NON REPRIS : le titre et le texte de l'annonce (la description est
 *            RÉGÉNÉRÉE depuis les faits par db/lib/describe.mjs), et toute
 *            donnée personnelle — nom, téléphone ou adresse électronique
 *            d'agent.
 *
 * Sur les photographies : `media.url` retient l'adresse de l'image chez la
 * source — c'est la référence et la trace de provenance — et le pipeline des
 * médias (`ops/process-media.sh`) la télécharge ensuite pour en produire nos
 * variantes, comme pour n'importe quelle photo venue du bot.
 *
 * Le détour est obligatoire, pas esthétique : le serveur d'images de la source
 * répond 403 à un navigateur qui affiche l'image depuis un autre site
 * (protection anti-hotlink Cloudflare), donc une fiche qui pointerait
 * directement chez elle n'afficherait que des cadres vides. Les variantes
 * vivent sous `var/media/` — hors dépôt — ou sur le stockage S3 en production.
 *
 * Politesse de collecte
 * ---------------------
 * Un agent utilisateur identifiable, une requête à la fois, une pause entre
 * chaque page, un nombre de pages borné par l'appelant, et rien en dehors des
 * chemins que le robots.txt de la source laisse ouverts. La collecte est un
 * travail ponctuel lancé à la main, pas une tâche planifiée.
 */

export const USER_AGENT =
  "cambodia-immo/0.1 (collecte d'annonces publiques ; contact via le dépôt du projet)";

/** Pause par défaut entre deux pages. Volontairement large. */
export const DEFAULT_DELAY_MS = 2500;

/**
 * Plafond de photos retenues par annonce. Les annonces du portail en portent
 * jusqu'à quarante ; au-delà de cinq, la galerie n'apporte plus rien à la
 * fiche et chaque image supplémentaire est un téléchargement et un jeu de
 * variantes de plus à produire pour toute la base.
 */
export const MAX_PHOTOS = 5;

/**
 * Sources connues.
 *
 * `robots.txt` de realestate.com.kh (relevé le 27/08/2026) ferme `/api/`,
 * `/dashboard/`, `/admin/`, `/accounts/`, les pages d'impression et les URL
 * d'images redimensionnées. Les listes `/buy/` et `/rent/` restent ouvertes à
 * `User-agent: *` : ce sont les seules que ce module lit.
 */
export const SOURCES = {
  "realestate.com.kh": {
    label: "Realestate.com.kh",
    slug: "realestate-com-kh",
    origin: "https://www.realestate.com.kh",
    lists: { sale: "/buy/", rent: "/rent/" },
    extract: extractNextData,
  },
};

/**
 * Catégories du portail vers les types du schéma.
 *
 * `Project` est volontairement absent : une fiche de programme neuf n'est pas
 * une unité à vendre, et le schéma a déjà un objet dédié (§ projets neufs).
 * Une catégorie inconnue fait écarter l'annonce plutôt que de la ranger au
 * hasard — une erreur de type se voit tout de suite sur la fiche.
 */
export const CATEGORY_TO_TYPE = {
  "condo": "condo",
  "apartment": "condo",
  "serviced apartment": "condo",
  "penthouse": "condo",
  "studio": "condo",
  "villa": "villa",
  "twin villa": "villa",
  "link villa": "villa",
  "queen villa": "villa",
  "king villa": "villa",
  "house": "borey_house",
  "link house": "borey_house",
  "borey": "borey_house",
  "townhouse": "borey_house",
  "flat": "flat_shophouse",
  "shophouse": "flat_shophouse",
  "land": "land",
  "office": "commercial",
  "office space": "commercial",
  "retail": "commercial",
  "retail space": "commercial",
  "commercial": "commercial",
  "shop": "commercial",
  "restaurant": "commercial",
  "warehouse": "warehouse",
  "factory": "warehouse",
  "whole building": "whole_building",
  "apartment building": "whole_building",
  "hotel": "whole_building",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Certaines annonces — les terrains surtout — affichent un prix AU MÈTRE
 * CARRÉ là où les autres affichent un total. Confondre les deux met en vitrine
 * un terrain de 2,8 hectares à 740 dollars.
 */
export const PER_SQM = /\/\s*(m²|m2|sqm)|per\s*(m²|m2|sqm)/i;

/** `"$5,500"` → 5500 ; `"POA"`, `""` ou une valeur illisible → null. */
export function parsePrice(text) {
  if (!text) return null;
  const raw = String(text).replace(/\s+/g, "");
  if (/^(poa|n\/a|-|—)$/i.test(raw)) return null;
  const m = raw.match(/([\d.,]+)\s*([mk])?/i);
  if (!m) return null;
  // Les milliers sont séparés par des virgules, la décimale par un point.
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const scale = m[2] ? { m: 1e6, k: 1e3 }[m[2].toLowerCase()] : 1;
  return Math.round(n * scale);
}

/**
 * En dessous, ce n'est pas une surface : la base réelle a montré un
 * appartement de deux chambres à « 1 m² ». Une valeur absente vaut mieux
 * qu'une valeur fausse — elle n'entre ni dans la description, ni dans le prix
 * au mètre carré, ni dans la déduplication.
 */
export const MIN_AREA_SQM = 10;

/** `"300m²"` → 300. Les surfaces du portail sont toujours en mètres carrés. */
export function parseArea(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= MIN_AREA_SQM ? Math.round(n) : null;
}

/**
 * Découpe `"Tonle Bassac, Chamkarmon, Phnom Penh"` du plus précis au plus
 * large. Les adresses du portail sont souvent préfixées d'espaces ou de
 * virgules vides ; on les jette.
 */
export function addressParts(address) {
  return String(address ?? "")
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 1 && /[a-zក-៿]/i.test(s));
}

/**
 * Emprise du pays, généreusement arrondie.
 *
 * Le portail publie parfois des coordonnées manifestement fausses — deux
 * annonces de Chaom Chau pointaient au milieu du Tchad. Une position qui n'est
 * pas au Cambodge n'est pas un pin approximatif, c'est une donnée cassée : on
 * écarte l'annonce plutôt que de poser un point aberrant sur la carte. Cela
 * couvre aussi le cas `null`, que `Number()` convertirait en 0.
 */
export const CAMBODIA_BBOX = { west: 102.0, east: 108.0, south: 9.5, north: 15.0 };

export function inCambodia(lng, lat) {
  return lng >= CAMBODIA_BBOX.west && lng <= CAMBODIA_BBOX.east
      && lat >= CAMBODIA_BBOX.south && lat <= CAMBODIA_BBOX.north;
}

/** Extrait les annonces d'une page de liste Next.js du portail. */
function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  return data?.props?.pageProps?.cacheData?.results?.data?.results ?? [];
}

/**
 * Traduit une annonce du portail en fiche de faits.
 *
 * Retourne `null` si l'annonce n'est pas exploitable : catégorie hors
 * périmètre, prix non public (« POA »), ou pin absent — dans ce dernier cas
 * l'annonce partirait de toute façon en `needs_pin`, et le principe n°2
 * interdit de géocoder une adresse texte pour combler le trou.
 */
export function toRecord(raw, source) {
  const type = CATEGORY_TO_TYPE[String(raw.categoryName ?? "").trim().toLowerCase()];
  if (!type) return null;

  const transaction = raw.listingType === "rent" ? "rent" : "sale";
  const priceText = transaction === "rent" ? raw.displayRent : raw.displayPrice;

  // `Number(null)` vaut 0, et 0/0 est un point au large du golfe de Guinée :
  // une coordonnée absente doit être reconnue comme absente, pas convertie en
  // pin. Sans ce garde-fou, les annonces sans position se retrouvent toutes
  // empilées au même endroit sur la carte.
  const lat = raw.addressLatitude, lng = raw.addressLongitude;
  if (typeof lat !== "number" || typeof lng !== "number"
      || !Number.isFinite(lat) || !Number.isFinite(lng)
      || !inCambodia(lng, lat)) return null;

  const spec = Object.fromEntries(
    (raw.specifications?.detail ?? []).map((s) => [s.type, s.shortLabel]));
  const indoorAreaSqm = parseArea(spec.floor_area);
  const landAreaSqm = parseArea(spec.land_area);

  let priceUsd = parsePrice(priceText);
  if (priceUsd && PER_SQM.test(String(priceText))) {
    // Un prix au mètre carré n'est un prix qu'accompagné d'une surface. Sans
    // elle, l'annonce est écartée plutôt que publiée à un montant faux.
    const area = landAreaSqm ?? indoorAreaSqm;
    priceUsd = area ? Math.round(priceUsd * area) : null;
  }
  if (!priceUsd) return null;

  return {
    portal: source.slug,
    externalRef: String(raw.id),
    sourceUrl: `${source.origin}${raw.url}`,
    transaction,
    category: raw.categoryName,
    propertyType: type,
    priceUsd,
    bedrooms: Number(spec.bedrooms) || 0,
    bathrooms: Number(spec.bathrooms) || 0,
    indoorAreaSqm,
    landAreaSqm,
    floor: spec.floor_level !== undefined ? Number(spec.floor_level) || null : null,
    addressParts: addressParts(raw.address),
    lat,
    lng,
    photoCount: Number(raw.imagesCount) || 0,
    listedAt: raw.createdAt ?? null,
    // La page de liste ne porte que la photo mise en avant. Elle suffit aux
    // cartes de résultats ; la galerie complète demande la page de l'annonce
    // (voir `fetchPhotos`).
    photos: toPhotos(raw.images ?? []),
    // Ni titre, ni description, ni contact : voir l'en-tête.
  };
}

/**
 * Traduit les images d'une annonce en médias.
 *
 * On garde l'original comme URL du média et les vignettes comme variantes, au
 * format que `Pic` attend. Le texte alternatif publié par la source n'est pas
 * repris : la fiche fabrique le sien à partir du type de bien et du quartier.
 */
export function toPhotos(images, max = MAX_PHOTOS) {
  return images
    // La galerie de la source mêle aux photographies des vignettes de carte
    // engendrées (`type: "map"`). Ce ne sont pas des photos du bien, et leur
    // serveur les refuse d'ailleurs : on ne garde que les vraies.
    .filter((img) => img?.type === undefined || img.type === "property")
    .filter((img) => typeof img?.url === "string" && img.url.startsWith("https://"))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .slice(0, max)
    .map((img) => {
      const sizes = (img.thumbnails ?? [])
        .filter((t) => typeof t?.url === "string")
        .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
      // La source publie l'original ET ses propres tailles. On retient la plus
      // grande vignette plutôt que l'original : elle suffit largement aux
      // variantes que le pipeline fabrique (1280 px au plus) et pèse cinq fois
      // moins à télécharger, ce qui compte sur des milliers d'images.
      const best = sizes[0] ?? img;
      return {
      url: best.url,
      width: Number(best.width) || null,
      height: Number(best.height) || null,
      // Décroissantes : `Pic` prend la première variante JPEG comme repli, et
      // ce repli doit être la plus grande, pas une vignette de 400 px.
      variants: sizes.map((t) => ({ url: t.url, format: "jpeg",
                                    width: Number(t.width) || 0,
                                    height: Number(t.height) || 0 })),
      };
    });
}

/**
 * Lit la galerie complète d'une annonce sur sa propre page.
 *
 * C'est une requête par annonce : à n'appeler que sur les annonces déjà
 * retenues, jamais en balayage.
 */
export async function fetchPhotos(sourceUrl, { fetchImpl, max = MAX_PHOTOS } = {}) {
  const get = fetchImpl ?? ((url) => fetch(url, { headers: { "user-agent": USER_AGENT } }));
  const res = await get(sourceUrl);
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const images = data?.props?.pageProps?.cacheData?.listing?.data?.showCase?.images;
  return Array.isArray(images) ? toPhotos(images, max) : null;
}

/**
 * Lit `pages` pages de liste pour une transaction donnée.
 *
 * @param {object} o
 * @param {string} o.portal   clé dans SOURCES
 * @param {"sale"|"rent"} o.transaction
 * @param {number} o.pages    nombre de pages à lire (20 annonces par page)
 * @param {number} [o.delayMs]
 * @param {(url: string) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>} [o.fetchImpl]
 *        injecté par les contrôles hors ligne
 * @param {(msg: string) => void} [o.onPage]
 */
export async function collect({ portal, transaction, pages, delayMs = DEFAULT_DELAY_MS,
                                fetchImpl, onPage }) {
  const source = SOURCES[portal];
  if (!source) throw new Error(`Portail inconnu : ${portal}`);
  const path = source.lists[transaction];
  if (!path) throw new Error(`Transaction inconnue : ${transaction}`);

  const get = fetchImpl ?? ((url) => fetch(url, { headers: { "user-agent": USER_AGENT } }));
  const records = [];
  const seen = new Set();

  for (let page = 1; page <= pages; page++) {
    const url = page === 1 ? `${source.origin}${path}` : `${source.origin}${path}?page=${page}`;
    const res = await get(url);
    if (!res.ok) {
      onPage?.(`${url} → HTTP ${res.status}, arrêt`);
      break;
    }
    const raws = source.extract(await res.text());
    let kept = 0;
    for (const raw of raws) {
      const rec = toRecord(raw, source);
      if (!rec || seen.has(rec.externalRef)) continue;
      seen.add(rec.externalRef);
      records.push(rec);
      kept++;
    }
    onPage?.(`${url} → ${raws.length} annonces, ${kept} exploitables`);
    // Une page vide signifie la fin de la liste : inutile d'insister.
    if (!raws.length) break;
    if (page < pages) await sleep(delayMs);
  }

  return records;
}
