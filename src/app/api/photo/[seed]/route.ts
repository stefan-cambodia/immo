/**
 * Photos du jeu de démonstration.
 *
 * Les visuels sont de vraies photographies libres de droits, déposées dans
 * `public/demo-photos` et créditées dans `public/demo-photos/CREDITS.md`. En
 * production, les médias sont servis depuis un stockage S3-compatible derrière
 * CDN, en WebP/AVIF et en plusieurs tailles (§7) : cette route ne sert qu'à
 * donner au seed des images crédibles sans embarquer une photo par bien.
 *
 * La graine posée par le seed vaut `{property_type}-{8 premiers caractères de
 * l'identifiant du bien}-{index}`. Elle porte donc tout ce qu'il faut :
 *
 *  - le TYPE choisit la catégorie de photos — un condo montre des intérieurs
 *    d'appartement, un terrain montre une parcelle ;
 *  - l'INDEX 0 est la vue extérieure de la fiche (la façade de l'immeuble pour
 *    les biens en étage, la catégorie du type sinon) ;
 *  - l'IDENTIFIANT fige la sélection : un bien garde ses photos d'un
 *    rechargement à l'autre, et deux médias qui partagent une graine — le cas
 *    des photos repiquées d'une agence à l'autre — servent le même fichier.
 *
 * Une graine dont le type n'est pas connu retombe sur l'ancien visuel
 * synthétique : la route ne casse jamais, même sur un média fabriqué à la main.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PHOTO_DIR = path.join(process.cwd(), "public", "demo-photos");

/**
 * Catégorie de photos par type de bien. `exterior` sert l'index 0, `interior`
 * les suivants. Les appartements en étage (condo, unité d'un immeuble entier)
 * s'ouvrent sur la façade de l'immeuble ; les autres types s'ouvrent sur leur
 * propre catégorie, qui est déjà faite de vues extérieures.
 *
 * `penthouse` n'est pas un type du schéma : ces intérieurs haut de gamme
 * complètent le fonds `condo`, dont ils partagent la nature (appartement en
 * étage). Les types `warehouse` et `whole_building`, absents de la liste
 * d'origine des catégories, tirent respectivement sur `warehouse` et sur les
 * façades d'immeubles.
 */
const CATEGORIES: Record<string, { exterior: string; interior: string[] }> = {
  condo:          { exterior: "building-exterior", interior: ["condo", "penthouse"] },
  villa:          { exterior: "villa",             interior: ["villa"] },
  borey_house:    { exterior: "borey",             interior: ["borey"] },
  flat_shophouse: { exterior: "shophouse",         interior: ["flat"] },
  land:           { exterior: "land",              interior: ["land"] },
  commercial:     { exterior: "commercial",        interior: ["commercial"] },
  warehouse:      { exterior: "warehouse",         interior: ["warehouse"] },
  whole_building: { exterior: "building-exterior", interior: ["flat"] },
};

/** `{type}-{id8}-{index}` — le type peut contenir des `_`, jamais de `-`. */
const SEED = /^([a-z_]+)-([0-9a-f]{8})-(\d+)$/;

/** Le hash historique de la route : stable, indépendant de la plateforme. */
function hash(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Inventaire des fichiers, relu une fois par processus. Ajouter un
 * `{catégorie}-{n}.jpg` suffit à l'intégrer : rien à déclarer ailleurs.
 */
let inventory: Promise<Map<string, string[]>> | null = null;
function catalogue() {
  inventory ??= readdir(PHOTO_DIR).then(
    (files) => {
      const byCategory = new Map<string, string[]>();
      const rank = new Map<string, number>();
      for (const file of files) {
        const m = /^(.+)-(\d+)\.jpg$/.exec(file);
        if (!m) continue;
        rank.set(file, Number(m[2]));
        const list = byCategory.get(m[1]);
        if (list) list.push(file);
        else byCategory.set(m[1], [file]);
      }
      // Tri numérique : l'ordre du système de fichiers ne doit pas décider
      // quelle photo va sur quel bien.
      for (const list of byCategory.values()) list.sort((a, b) => rank.get(a)! - rank.get(b)!);
      return byCategory;
    },
    () => new Map<string, string[]>()
  );
  return inventory;
}

/**
 * Ordre de parcours propre à un bien. Un simple `hash % n` redonnerait deux
 * fois la même photo dans une galerie de six ; un mélange déterministe garantit
 * que les premières positions tirent des fichiers distincts.
 */
function order(files: string[], seedValue: number) {
  const out = [...files];
  let s = seedValue || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function photo(seed: string) {
  const m = SEED.exec(seed);
  if (!m) return null;
  const category = CATEGORIES[m[1]];
  if (!category) return null;

  const index = Number(m[3]);
  const byCategory = await catalogue();
  // Beaucoup de types n'ont qu'une catégorie : l'index 0 et les suivants
  // puisent alors dans le même fonds, et doivent donc se partager le même
  // compteur pour ne pas se répéter.
  const single = category.interior.length === 1 && category.interior[0] === category.exterior;
  const names = index === 0 && !single
    ? byCategory.get(category.exterior) ?? []
    : category.interior.flatMap((c) => byCategory.get(c) ?? []);
  if (!names.length) return null;

  // Le mélange dépend du bien, pas du média : les photos d'une même fiche
  // restent cohérentes entre elles et stables d'un rechargement à l'autre.
  const position = single ? index : Math.max(0, index - 1);
  const file = order(names, hash(`${m[1]}-${m[2]}`))[position % names.length];
  return readFile(path.join(PHOTO_DIR, file)).catch(() => null);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seed: string }> }
) {
  const { seed } = await params;
  const cache = "public, max-age=31536000, immutable";

  const jpeg = await photo(seed);
  if (jpeg) {
    return new Response(new Uint8Array(jpeg), {
      headers: { "content-type": "image/jpeg", "cache-control": cache },
    });
  }

  // Repli : catégorie inconnue ou fonds de photos absent. Le visuel synthétique
  // d'origine garde la démo debout plutôt que de servir un 404 dans une fiche.
  const h = hash(seed);
  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 22% 78%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 20% 55%)"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <g fill="hsl(${hue} 18% 40%)" opacity="0.35">
    <rect x="${120 + (h % 120)}" y="380" width="240" height="300"/>
    <rect x="${400 + (h % 90)}" y="300" width="200" height="380"/>
    <rect x="${660 + (h % 140)}" y="420" width="280" height="260"/>
  </g>
  <rect y="660" width="1200" height="140" fill="hsl(${hue} 16% 32%)" opacity="0.25"/>
</svg>`;

  return new Response(svg, {
    headers: { "content-type": "image/svg+xml", "cache-control": cache },
  });
}
