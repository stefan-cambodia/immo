/**
 * Image responsive du budget de performance (§7) : `<picture>` avec sources
 * AVIF puis WebP quand les variantes existent, repli JPEG (ou URL source
 * tant que le média n'est pas traité). Aucun JavaScript — le choix du
 * format et de la taille appartient au navigateur.
 */

import type { MediaVariant } from "@/lib/search";

const srcSetFor = (variants: MediaVariant[], format: string) => {
  const set = variants.filter((v) => v.format === format);
  return set.length ? set.map((v) => `${v.url} ${v.width}w`).join(", ") : null;
};

export function Pic({
  url, variants, alt, sizes, width, height, loading, fetchPriority, style,
}: {
  url: string;
  variants?: MediaVariant[] | null;
  alt: string;
  /** Attribut `sizes` : la largeur d'affichage réelle, pour que le
   *  navigateur choisisse la plus petite variante suffisante. */
  sizes: string;
  width: number;
  height: number;
  loading?: "lazy" | "eager";
  fetchPriority?: "high" | "low" | "auto";
  style?: React.CSSProperties;
}) {
  const all = variants ?? [];
  const avif = srcSetFor(all, "avif");
  const webp = srcSetFor(all, "webp");
  // Le repli est la variante JPEG quand elle existe : l'URL source peut
  // être éphémère (photo Telegram), nos variantes non.
  const fallback = all.find((v) => v.format === "jpeg")?.url ?? url;

  return (
    // `display: contents` : le <picture> disparaît de la mise en page, seul
    // l'<img> participe aux grilles et flex — les styles existants (hauteur
    // 100 %, flexShrink) continuent de s'appliquer comme avant.
    <picture style={{ display: "contents" }}>
      {avif && <source type="image/avif" srcSet={avif} sizes={sizes} />}
      {webp && <source type="image/webp" srcSet={webp} sizes={sizes} />}
      <img
        src={fallback}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        fetchPriority={fetchPriority}
        decoding="async"
        style={style}
      />
    </picture>
  );
}
