"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MlMap, Marker } from "maplibre-gl";

/**
 * Principe verrouillé n°2 : le pin de la carte est posé à la main, jamais
 * géocodé depuis une adresse texte. C'est une étape bloquante de la saisie —
 * le formulaire ne peut pas être soumis tant que le pin n'est pas posé.
 */
export function PinPicker({
  style, attribution, maxZoom, center, zoom, labels,
}: {
  style: string | Record<string, unknown>;
  attribution: string;
  maxZoom: number;
  center: [number, number];
  zoom: number;
  labels: { required: string; hint: string; done: string; submit: string };
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const [pin, setPin] = useState<[number, number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const maplibre = (await import("maplibre-gl")).default;
      if (cancelled || !container.current || map.current) return;

      const m = new maplibre.Map({
        container: container.current,
        style: style as never,
        center, zoom, maxZoom,
        attributionControl: { compact: true, customAttribution: attribution },
      });
      m.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      m.getCanvas().style.cursor = "crosshair";
      map.current = m;

      m.on("click", (e) => {
        const at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (!marker.current) {
          marker.current = new maplibre.Marker({ color: "#0f6a5f", draggable: true })
            .setLngLat(at)
            .addTo(m);
          marker.current.on("dragend", () => {
            const l = marker.current!.getLngLat();
            setPin([l.lng, l.lat]);
          });
        } else {
          marker.current.setLngLat(at);
        }
        setPin(at);
      });
    })();
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
      <div>
        <strong style={{ display: "block", fontSize: "0.875rem" }}>
          {labels.required} <span style={{ color: "var(--color-danger)" }}>*</span>
        </strong>
        <span style={{ fontSize: "0.75rem", color: "var(--color-ink-soft)", lineHeight: 1.55 }}>
          {labels.hint}
        </span>
      </div>

      <div
        ref={container}
        style={{
          height: "clamp(240px, 38vh, 380px)",
          borderRadius: "0.625rem",
          overflow: "hidden",
          border: `1px solid ${pin ? "var(--color-brand)" : "var(--color-danger)"}`,
        }}
      />

      <input type="hidden" name="lng" value={pin?.[0] ?? ""} />
      <input type="hidden" name="lat" value={pin?.[1] ?? ""} />

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary" disabled={!pin}
                style={{ opacity: pin ? 1 : 0.45, cursor: pin ? "pointer" : "not-allowed" }}>
          {labels.submit}
        </button>
        {pin && (
          <span className="chip" style={{ background: "var(--color-brand-soft)", color: "var(--color-brand)" }}>
            ✓ {labels.done} · {pin[1].toFixed(5)}, {pin[0].toFixed(5)}
          </span>
        )}
      </div>
    </div>
  );
}
