import sharp from "sharp";

/**
 * Empreinte perceptuelle des photos (§6.2).
 *
 * Les agences se repiquent les images entre elles — c'est un fait de marché,
 * et donc un signal exploitable pour retrouver un même bien publié par
 * plusieurs agences. Mais elles les recompressent, les recadrent, y collent
 * un filigrane : une comparaison octet à octet ne trouverait rien.
 *
 * Le dHash compare la luminosité de pixels voisins après réduction à 9×8 en
 * niveaux de gris. Il ne retient que la structure de l'image, donc il survit
 * au rééchantillonnage, au changement de qualité JPEG et aux petites
 * variations de couleur.
 */
const WIDTH = 9;
const HEIGHT = 8;

/** Empreinte 64 bits, rendue en chaîne binaire pour le type `bit(64)`. */
export async function computePhash(input) {
  const raw = await sharp(input, { failOn: "none" })
    .grayscale()
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer();

  let bits = "";
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH - 1; x++) {
      const left = raw[y * WIDTH + x];
      const right = raw[y * WIDTH + x + 1];
      bits += left > right ? "1" : "0";
    }
  }
  return bits; // 8 lignes × 8 comparaisons = 64 bits
}

/** Distance de Hamming entre deux empreintes binaires. */
export function hamming(a, b) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Seuils mesurés, pas devinés. Sur des scènes de test structurellement
 * distinctes (blocs clairs/sombres à des positions variables, ce que dHash
 * lit réellement) :
 *
 *   même image, JPEG qualité 30      → 1
 *   même image réduite de moitié     → 1
 *   même image recadrée de 8 %       → 3
 *   même image avec filigrane        → 4
 *   dix images différentes           → 11, 13, 18, 19, 21, 21, 21, 26, 28, 33
 *
 * D'où ≤ 6 pour « même photo » et une zone grise qui s'arrête à 10, juste
 * sous le minimum observé pour des images sans rapport.
 *
 * AVERTISSEMENT, et c'est la raison pour laquelle le moteur de déduplication
 * ne fusionne jamais sur ce seul signal : dHash ne retient que la structure
 * grossière. Deux photos réellement différentes mais de composition très
 * proche — deux studios identiques du même immeuble, photographiés au même
 * endroit avec le même objectif — peuvent tomber à une distance nulle. Le
 * hash est une corroboration, jamais une preuve.
 */
export const PHASH_SAME = 6;
export const PHASH_MAYBE = 10;

export function phashVerdict(distance) {
  if (distance <= PHASH_SAME) return "same";
  if (distance <= PHASH_MAYBE) return "maybe";
  return "different";
}
