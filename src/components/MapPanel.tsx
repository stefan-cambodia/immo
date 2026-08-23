"use client";

import dynamic from "next/dynamic";

// La carte n'est chargée qu'au besoin : elle ne doit pas peser sur le premier
// rendu de la page de résultats (budget bundle §7).
export const MapPanel = dynamic(
  () => import("./ResultsMap").then((m) => m.ResultsMap),
  {
    ssr: false,
    loading: () => (
      <div className="ph" style={{ position: "absolute", inset: 0 }} aria-hidden />
    ),
  }
);
