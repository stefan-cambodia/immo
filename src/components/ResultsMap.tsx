"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";

interface Point {
  id: string; reference: string; lng: number; lat: number;
  price: string; type: string; beds: number; agencies: number;
}

interface Labels {
  searchThisArea: string;
  drawPolygon: string;
  clearPolygon: string;
  finishPolygon: string;
  autoSearch: string;
  loading: string;
  bedrooms: string;
  /** Gabarit `{n} agences` : la substitution se fait dans la bulle. */
  agencyCount: string;
  unavailable: string;
  unavailableHint: string;
}

const compactUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `$${Math.round(n / 1000)}k`
  : `$${n}`;

export function ResultsMap({
  locale, style, attribution, maxZoom, center, zoom, labels, mode = "search",
}: {
  locale: string;
  style: string | Record<string, unknown>;
  attribution: string;
  maxZoom: number;
  center: [number, number];
  zoom: number;
  labels: Labels;
  /**
   * `search` : la carte est un outil de recherche — dessin de zone, « chercher
   * dans cette zone », suivi du déplacement.
   *
   * `locate` : la carte SITUE un bien déjà choisi. Les commandes de recherche
   * n'y ont pas de sens — dessiner un polygone sur la fiche d'un appartement
   * ne mène nulle part — et elles encombrent une carte qu'on ne regarde que
   * pour savoir où c'est.
   */
  mode?: "search" | "locate";
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const router = useRouter();
  const params = useSearchParams();
  const paramString = params.toString();

  const [ready, setReady] = useState(false);
  // MapLibre est un moteur WebGL : sans contexte WebGL, il lève à la
  // construction. Un navigateur ancien, une accélération matérielle coupée ou
  // un pilote sur liste noire suffisent. Sans ce drapeau, l'exception n'est
  // rattrapée nulle part et le panneau reste indéfiniment vide sous un
  // « Chargement… » qui ne s'éteint jamais — le pire des deux mondes, puisque
  // le visiteur attend quelque chose qui ne viendra pas.
  const [failed, setFailed] = useState(false);
  // Le chargement est un état dérivé : « les points affichés correspondent-ils
  // aux filtres courants ? » — pas un drapeau posé/levé dans l'effet.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loading = loadedFor !== paramString;
  const [moved, setMoved] = useState(false);
  const [autoSearch, setAutoSearch] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const draft = useRef<[number, number][]>([]);
  const [draftCount, setDraftCount] = useState(0);

  // ------------------------------------------------------------- init carte
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Import différé : maplibre ne pèse pas sur le bundle initial (budget §7).
      let maplibre;
      let m: MlMap;
      try {
        maplibre = (await import("maplibre-gl")).default;
        if (cancelled || !container.current || map.current) return;

        m = new maplibre.Map({
          container: container.current,
          style: style as never,
          center,
          zoom,
          maxZoom,
          attributionControl: { compact: true, customAttribution: attribution },
        });
      } catch {
        // Pas de WebGL, ou le module n'a pas pu être chargé : on le dit, et la
        // page reste utilisable — la carte n'est pas le seul chemin vers les
        // biens, la liste de résultats est à côté.
        if (!cancelled) setFailed(true);
        return;
      }
      m.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.current = m;

      m.on("load", () => {
        m.addSource("properties", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          cluster: true,          // Phnom Penh sature immédiatement sans clustering (§5.4).
          clusterRadius: 55,
          clusterMaxZoom: 15,
        });

        m.addLayer({
          id: "clusters", type: "circle", source: "properties", filter: ["has", "point_count"],
          paint: {
            "circle-color": "#0f6a5f",
            "circle-opacity": 0.9,
            "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 30, 200, 38],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
        m.addLayer({
          id: "cluster-count", type: "symbol", source: "properties", filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-size": 12, "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-allow-overlap": true,
          },
          paint: { "text-color": "#ffffff" },
        });
        m.addLayer({
          id: "points", type: "circle", source: "properties", filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": 7,
            "circle-color": ["case", [">", ["get", "agencies"], 1], "#b8852a", "#0f6a5f"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
        m.addLayer({
          id: "price-labels", type: "symbol", source: "properties",
          filter: ["!", ["has", "point_count"]],
          minzoom: 14,
          layout: {
            "text-field": ["get", "label"], "text-size": 11,
            "text-offset": [0, 1.3], "text-anchor": "top",
            "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
          },
          paint: { "text-color": "#14181d", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
        });

        // Contour du polygone dessiné à main levée.
        m.addSource("draw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({
          id: "draw-fill", type: "fill", source: "draw",
          paint: { "fill-color": "#0f6a5f", "fill-opacity": 0.12 },
        });
        m.addLayer({
          id: "draw-line", type: "line", source: "draw",
          paint: { "line-color": "#0f6a5f", "line-width": 2, "line-dasharray": [2, 1] },
        });

        m.on("click", "clusters", async (e) => {
          const f = m.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
          const src = m.getSource("properties") as GeoJSONSource;
          const z = await src.getClusterExpansionZoom(f.properties!.cluster_id as number);
          m.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: z });
        });

        m.on("click", "points", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, string>;
          // Sous le prix : ce qui distingue ce bien, et rien d'autre. Un
          // nombre de chambres nu se lisait « $120k / 4 » ; à zéro — un
          // terrain — il n'a rien à dire. Le nombre d'agences est un signal
          // (« le même bien, plusieurs annonces ») : à une seule agence il
          // n'en est pas un, comme le badge des cartes de résultats.
          const beds = Number(p.beds) || 0;
          const agencies = Number(p.agencies) || 0;
          const facts = [
            beds > 0 ? `${beds} ${labels.bedrooms}` : null,
            agencies > 1 ? labels.agencyCount.replace("{n}", String(agencies)) : null,
          ].filter(Boolean).join(" · ");

          new maplibre.Popup({ offset: 12, closeButton: false })
            .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(
              `<a href="/${locale}/property/${p.reference}" style="display:block;font:600 13px system-ui;color:#0f6a5f;text-decoration:none">
                 ${p.label}${facts
                   ? `<br><span style="font-weight:400;color:#4a5560">${facts}</span>`
                   : ""}
               </a>`
            )
            .addTo(m);
        });

        for (const layer of ["clusters", "points"]) {
          m.on("mouseenter", layer, () => { m.getCanvas().style.cursor = "pointer"; });
          m.on("mouseleave", layer, () => { m.getCanvas().style.cursor = ""; });
        }

        // Le déplacement n'est suivi que là où il ouvre sur une action : sans
        // le bouton « chercher dans cette zone », c'est un rendu par panoramique
        // pour rien.
        if (mode === "search") m.on("moveend", () => setMoved(true));
        setReady(true);
      });
    })();

    return () => { cancelled = true; map.current?.remove(); map.current = null; };
    // Le style et le centre initial ne changent pas pendant la vie du composant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------- chargement des points
  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    fetch(`/api/map?${paramString}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((points: Point[]) => {
        const src = map.current?.getSource("properties") as GeoJSONSource | undefined;
        src?.setData({
          type: "FeatureCollection",
          features: points.map((p) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
            properties: {
              reference: p.reference,
              agencies: p.agencies,
              beds: p.beds,
              label: compactUsd(Number(p.price)),
            },
          })),
        });
        setLoadedFor(paramString);
        setMoved(false);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [ready, paramString]);

  // ------------------------------------------- « rechercher dans cette zone »
  const searchThisArea = () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const next = new URLSearchParams(paramString);
    next.set("bbox", [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(","));
    next.delete("area");
    next.delete("page");
    router.replace(`?${next.toString()}`, { scroll: false });
    setMoved(false);
  };

  useEffect(() => {
    if (autoSearch && moved) searchThisArea();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearch, moved]);

  // ------------------------------------------------- dessin de polygone (§5.4)
  // Les acheteurs raisonnent en « autour de BKK1 », pas en rayon kilométrique.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const redraw = () => {
      const src = m.getSource("draw") as GeoJSONSource;
      const ring = draft.current;
      src.setData(
        ring.length < 2
          ? { type: "FeatureCollection", features: [] }
          : {
              type: "Feature",
              geometry: ring.length < 3
                ? { type: "LineString", coordinates: ring }
                : { type: "Polygon", coordinates: [[...ring, ring[0]]] },
              properties: {},
            }
      );
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      draft.current = [...draft.current, [e.lngLat.lng, e.lngLat.lat]];
      setDraftCount(draft.current.length);
      redraw();
    };

    if (drawing) {
      m.getCanvas().style.cursor = "crosshair";
      m.on("click", onClick);
    }
    return () => { m.off("click", onClick); m.getCanvas().style.cursor = ""; };
  }, [drawing, ready]);

  const finishPolygon = () => {
    if (draft.current.length < 3) { setDrawing(false); return; }
    const next = new URLSearchParams(paramString);
    next.set("polygon", draft.current.map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(";"));
    next.delete("bbox");
    next.delete("area");
    next.delete("page");
    router.replace(`?${next.toString()}`, { scroll: false });
    setDrawing(false);
  };

  const clearPolygon = () => {
    draft.current = [];
    setDraftCount(0);
    const src = map.current?.getSource("draw") as GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: [] });
    const next = new URLSearchParams(paramString);
    next.delete("polygon");
    router.replace(next.toString() ? `?${next.toString()}` : "?", { scroll: false });
    setDrawing(false);
  };

  const hasPolygon = params.get("polygon") !== null || draftCount > 0;

  if (failed) {
    return (
      <div style={{
        position: "relative", width: "100%", height: "100%", minHeight: 320,
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: "0.375rem", padding: "1.5rem",
        textAlign: "center", background: "var(--color-surface-alt)",
      }} role="status">
        <strong style={{ fontSize: "0.9375rem" }}>{labels.unavailable}</strong>
        <span style={{ fontSize: "0.8125rem", color: "var(--color-ink-soft)", maxWidth: "28rem" }}>
          {labels.unavailableHint}
        </span>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 320 }}>
      <div ref={container} style={{ position: "absolute", inset: 0 }} />

      {/* Commandes de recherche : uniquement là où elles mènent quelque part. */}
      {mode === "search" && (
      <div style={{
        position: "absolute", top: 10, left: 10, display: "flex",
        flexDirection: "column", gap: "0.5rem", alignItems: "start", zIndex: 5,
      }}>
        {moved && !autoSearch && (
          <button className="btn btn-primary" onClick={searchThisArea}
                  style={{ boxShadow: "0 2px 10px rgb(0 0 0 / 0.2)" }}>
            {labels.searchThisArea}
          </button>
        )}
        <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
          {!drawing ? (
            <button className="btn btn-outline"
                    onClick={() => { draft.current = []; setDraftCount(0); setDrawing(true); }}
                    style={{ padding: "0.375rem 0.625rem", fontSize: "0.8125rem" }}>
              ✎ {labels.drawPolygon}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={finishPolygon}
                    style={{ padding: "0.375rem 0.625rem", fontSize: "0.8125rem" }}>
              ✓ {labels.finishPolygon}
            </button>
          )}
          {hasPolygon && (
            <button className="btn btn-outline" onClick={clearPolygon}
                    style={{ padding: "0.375rem 0.625rem", fontSize: "0.8125rem" }}>
              ✕ {labels.clearPolygon}
            </button>
          )}
        </div>
        <label style={{
          display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.75rem",
          background: "var(--color-surface)", border: "1px solid var(--color-line)",
          borderRadius: "0.5rem", padding: "0.25rem 0.5rem", cursor: "pointer",
        }}>
          <input type="checkbox" checked={autoSearch} onChange={(e) => setAutoSearch(e.target.checked)} />
          {labels.autoSearch}
        </label>
      </div>
      )}

      {loading && (
        <span className="chip" style={{
          position: "absolute", bottom: 10, left: 10, zIndex: 5,
          background: "var(--color-surface)", color: "var(--color-ink-soft)",
          border: "1px solid var(--color-line)",
        }}>
          {labels.loading}
        </span>
      )}
    </div>
  );
}
