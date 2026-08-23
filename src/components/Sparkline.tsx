/**
 * Courbe vues / contacts en SVG pur.
 *
 * Pas de bibliothèque de graphiques : le budget de bundle du portail est de
 * 200 ko (§7) et une courbe à deux séries se dessine en quelques lignes. Le
 * rendu est serveur, donc la page reste lisible sans JavaScript.
 */
export function Sparkline({
  series, labels, height = 90,
}: {
  series: { day: string; views: number; leads: number }[];
  labels: { views: string; leads: string };
  height?: number;
}) {
  if (series.length < 2) return null;

  const w = 640;
  const pad = 4;
  const maxViews = Math.max(1, ...series.map((s) => s.views));
  const maxLeads = Math.max(1, ...series.map((s) => s.leads));

  const path = (key: "views" | "leads", max: number) =>
    series
      .map((s, i) => {
        const x = (i / (series.length - 1)) * (w - pad * 2) + pad;
        const y = height - pad - (s[key] / max) * (height - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const area = `${path("views", maxViews)} L${w - pad},${height - pad} L${pad},${height - pad} Z`;

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height}
           preserveAspectRatio="none" role="img"
           aria-label={`${labels.views} / ${labels.leads}`}>
        <path d={area} fill="var(--color-brand)" opacity="0.10" />
        <path d={path("views", maxViews)} fill="none" stroke="var(--color-brand)"
              strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {/* Les contacts ont leur propre échelle : à l'échelle des vues, une
            courbe à 2 % serait collée à l'axe et illisible. */}
        <path d={path("leads", maxLeads)} fill="none" stroke="var(--color-gold)"
              strokeWidth="1.5" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", gap: "1rem", fontSize: "0.6875rem",
                    color: "var(--color-ink-soft)", marginTop: "0.375rem", flexWrap: "wrap" }}>
        <span><span style={{ color: "var(--color-brand)" }}>—</span> {labels.views} (max {maxViews})</span>
        <span><span style={{ color: "var(--color-gold)" }}>- -</span> {labels.leads} (max {maxLeads})</span>
        <span style={{ marginInlineStart: "auto" }}>{series[0].day} → {series[series.length - 1].day}</span>
      </div>
    </div>
  );
}
