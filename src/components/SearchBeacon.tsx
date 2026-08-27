"use client";

import { useEffect } from "react";

/**
 * Compte une recherche en texte libre, aboutie ou non.
 *
 * Côté client, et non pendant le rendu : une page de résultats se rend aussi
 * à la pagination, au rechargement et au préchargement, sans que personne
 * n'ait cherché quoi que ce soit. Le dédoublonnage par session et par jour
 * finit le travail côté serveur — affiner ses filtres sur la même requête est
 * une recherche, pas quinze.
 */
export function SearchBeacon({ q, locale, resolved }: {
  q: string; locale: string; resolved: boolean;
}) {
  useEffect(() => {
    if (!q.trim()) return;

    // Même jeton que la mesure d'audience : opaque, local, rattaché à aucune
    // identité. Le partager évite d'en poser un second pour rien.
    let session = "";
    try {
      session = localStorage.getItem("vs") ?? "";
      if (!session) {
        session = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
        localStorage.setItem("vs", session);
      }
    } catch {
      session = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
    }

    const payload = JSON.stringify({ q, locale, resolved, session });
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (!navigator.sendBeacon?.("/api/searches", blob)) {
        fetch("/api/searches", { method: "POST", body: payload, keepalive: true,
                                 headers: { "content-type": "application/json" } }).catch(() => {});
      }
    } catch { /* la mesure ne doit jamais gêner la recherche */ }
  }, [q, locale, resolved]);

  return null;
}
