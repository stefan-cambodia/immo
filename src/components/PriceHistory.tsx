import { formatDate, formatUsd } from "@/lib/format";
import type { Locale, Translator } from "@/lib/i18n";

interface Point { price: string | number; at: string }

/** Historique de prix : les prix bougent beaucoup et les acheteurs négocient (§6.3). */
export function PriceHistory({
  history, locale, t,
}: { history: Point[]; locale: Locale; t: Translator }) {
  if (!history || history.length < 2) return null;

  const values = history.map((h) => Number(h.price));
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const w = 220, h = 44;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = values[0], last = values[values.length - 1];
  const delta = last - first;
  const down = delta < 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.875rem", flexWrap: "wrap" }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img"
           aria-label={t("property.priceHistory")} style={{ flexShrink: 0 }}>
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke={down ? "var(--color-fresh)" : "var(--color-gold)"}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => {
          const [x, y] = p.split(",");
          return <circle key={i} cx={x} cy={y} r="2.5"
                         fill={down ? "var(--color-fresh)" : "var(--color-gold)"} />;
        })}
      </svg>
      <div style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
        <strong style={{ color: down ? "var(--color-fresh)" : "var(--color-gold)" }}>
          {t(down ? "property.priceDropped" : "property.priceRaised",
             { amount: formatUsd(Math.abs(delta), locale, true) })}
        </strong>
        <br />
        {formatDate(history[0].at, locale)} → {formatDate(history[history.length - 1].at, locale)}
      </div>
    </div>
  );
}
