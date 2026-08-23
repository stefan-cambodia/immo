"use client";

import { useEffect } from "react";

/**
 * Compte une vue de fiche.
 *
 * Côté client, et non pendant le rendu de la page : la fiche est servie en ISR
 * avec revalidation, donc un rendu ne correspond pas à une visite. Compter au
 * rendu donnerait un chiffre décorrélé de l'audience réelle.
 *
 * `sendBeacon` survit à une navigation immédiate et ne retarde pas la page.
 */
export function ViewBeacon({ propertyId, locale }: { propertyId: string; locale: string }) {
  useEffect(() => {
    let session = "";
    try {
      session = localStorage.getItem("vs") ?? "";
      if (!session) {
        session = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
        localStorage.setItem("vs", session);
      }
    } catch {
      // Navigation privée ou stockage refusé : la vue est comptée sur une
      // session éphémère plutôt que perdue.
      session = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
    }

    const payload = JSON.stringify({ propertyId, locale, session });
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (!navigator.sendBeacon?.("/api/views", blob)) {
        fetch("/api/views", { method: "POST", body: payload, keepalive: true,
                              headers: { "content-type": "application/json" } }).catch(() => {});
      }
    } catch { /* la mesure ne doit jamais gêner la consultation */ }
  }, [propertyId, locale]);

  return null;
}
