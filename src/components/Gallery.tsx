// Galerie sans JavaScript : défilement natif avec scroll-snap. Sur réseau
// contraint, tout ce qui peut être fait en CSS l'est (principe n°4).
export function Gallery({ photos, alt }: { photos: { url: string }[]; alt: string }) {
  if (!photos.length) return <div className="ph" style={{ aspectRatio: "16 / 9", borderRadius: "0.75rem" }} />;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: photos.length > 1 ? "minmax(0, 2fr) minmax(0, 1fr)" : "1fr",
      gap: "0.5rem",
      borderRadius: "0.75rem",
      overflow: "hidden",
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photos[0].url}
        alt={alt}
        width={1200}
        height={800}
        // Image LCP de la fiche : chargée en priorité, pas en lazy (§7).
        fetchPriority="high"
        decoding="async"
        style={{ width: "100%", aspectRatio: "3 / 2", objectFit: "cover", background: "var(--color-surface-alt)" }}
      />
      {photos.length > 1 && (
        <div style={{
          display: "grid", gap: "0.5rem",
          gridTemplateRows: `repeat(${Math.min(2, photos.length - 1)}, 1fr)`,
        }}>
          {photos.slice(1, 3).map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.url}
              src={p.url}
              alt=""
              loading="lazy"
              decoding="async"
              width={600}
              height={400}
              style={{ width: "100%", height: "100%", objectFit: "cover", background: "var(--color-surface-alt)" }}
            />
          ))}
        </div>
      )}
      {photos.length > 3 && (
        <div style={{
          gridColumn: "1 / -1", display: "flex", gap: "0.5rem", overflowX: "auto",
          scrollSnapType: "x mandatory", paddingBottom: "0.25rem",
        }}>
          {photos.slice(3).map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.url}
              src={p.url}
              alt=""
              loading="lazy"
              decoding="async"
              width={240}
              height={160}
              style={{
                width: "clamp(120px, 22vw, 180px)", aspectRatio: "3 / 2", objectFit: "cover",
                borderRadius: "0.5rem", scrollSnapAlign: "start", flexShrink: 0,
                background: "var(--color-surface-alt)",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
