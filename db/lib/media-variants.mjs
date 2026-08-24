/**
 * Variantes d'images — le budget de performance rendu exécutable (§7) :
 * « images en WebP/AVIF, plusieurs tailles ».
 *
 * Trois largeurs, calées sur les usages réels du site : 320 (vignette de
 * carte et de liste sur mobile), 640 (carte sur écran dense, mosaïque de
 * galerie), 1280 (image principale de la fiche). Jamais d'agrandissement :
 * une source plus étroite donne simplement moins de variantes.
 *
 * Deux formats modernes (AVIF, WebP) plus un JPEG à la plus grande taille :
 * c'est lui que le `<img>` de repli sert, pour que la fiche reste lisible
 * sur les navigateurs qui ne connaissent ni l'un ni l'autre. L'URL source
 * cesse d'être servie une fois les variantes en place — une photo Telegram
 * expire, nos variantes non.
 */
import sharp from "sharp";
import { computePhash } from "./phash.mjs";

export const VARIANT_WIDTHS = [320, 640, 1280];

// Qualités calées sur l'usage photo immobilier : AVIF compresse mieux à
// qualité perçue égale, le JPEG de repli reste raisonnable.
const FORMATS = [
  { format: "avif", quality: 55, contentType: "image/avif" },
  { format: "webp", quality: 78, contentType: "image/webp" },
];
const FALLBACK = { format: "jpeg", quality: 80, contentType: "image/jpeg" };

/**
 * Produit les variantes d'une image source.
 * Renvoie { width, height, phash, files: [{ format, width, height,
 * contentType, body }] } — l'appelant décide où les stocker.
 */
export async function buildVariants(input) {
  const image = sharp(input, { failOn: "none" }).rotate(); // EXIF appliqué
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("image illisible");

  const widths = VARIANT_WIDTHS.filter((w) => w <= meta.width);
  if (widths.length === 0) widths.push(meta.width); // source plus étroite que 320

  const files = [];
  const jobs = [];
  for (const { format, quality, contentType } of FORMATS) {
    for (const width of widths) {
      jobs.push({ format, quality, contentType, width });
    }
  }
  jobs.push({ ...FALLBACK, width: widths[widths.length - 1] });

  for (const job of jobs) {
    const { data, info } = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(job.width, null, { withoutEnlargement: true })
      .toFormat(job.format, { quality: job.quality })
      .toBuffer({ resolveWithObject: true });
    files.push({
      format: job.format,
      width: info.width,
      height: info.height,
      contentType: job.contentType,
      body: data,
    });
  }

  return {
    width: meta.width,
    height: meta.height,
    phash: await computePhash(input),
    files,
  };
}
