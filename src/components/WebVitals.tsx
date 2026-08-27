"use client";

import { useEffect } from "react";

/**
 * Remonte le LCP mesuré par le navigateur (§7, §10).
 *
 * Trois précautions, et chacune corrige une manière classique de se mentir
 * sur cette mesure :
 *
 * 1. LE LCP N'EST DÉFINITIF QU'À LA FIN. Le navigateur émet plusieurs
 *    candidats à mesure que la page se peint, chacun remplaçant le précédent.
 *    Remonter le premier flatte le chiffre. On garde donc le dernier, et on
 *    ne l'envoie qu'au moment où la page devient invisible.
 * 2. UNE PAGE QUI DÉMARRE MASQUÉE N'A PAS DE LCP UTILE. Un onglet ouvert en
 *    arrière-plan peint quand il veut : sa mesure ne dit rien de l'expérience
 *    et tirerait le centile vers le haut.
 * 3. UNE INTERACTION ARRÊTE LE COMPTE. Le navigateur cesse de nommer des
 *    candidats au premier geste de l'utilisateur ; c'est voulu, et il ne faut
 *    pas relancer l'observation après.
 *
 * Aucun paquet ajouté : `PerformanceObserver` suffit pour le LCP, et le
 * budget de bundle est de 200 ko (§7).
 */
export function WebVitals({ locale, route }: { locale: string; route: string }) {
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    if (document.visibilityState === "hidden") return;

    let last = 0;
    let sent = false;

    let observer: PerformanceObserver;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) last = entry.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // Navigateur sans LCP (Safari ancien, Firefox jusqu'à récemment) : pas
      // de mesure plutôt qu'une mesure fabriquée.
      return;
    }

    const send = () => {
      if (sent || last <= 0) return;
      sent = true;
      observer.disconnect();
      const payload = JSON.stringify({ metric: "lcp", value: last, locale, route });
      try {
        const blob = new Blob([payload], { type: "application/json" });
        if (!navigator.sendBeacon?.("/api/vitals", blob)) {
          fetch("/api/vitals", { method: "POST", body: payload, keepalive: true,
                                 headers: { "content-type": "application/json" } }).catch(() => {});
        }
      } catch { /* la mesure ne doit jamais gêner la consultation */ }
    };

    const onHidden = () => { if (document.visibilityState === "hidden") send(); };
    document.addEventListener("visibilitychange", onHidden);
    // `pagehide` couvre les cas où `visibilitychange` n'arrive pas — retour
    // arrière depuis le cache de navigation, fermeture brutale sur iOS.
    window.addEventListener("pagehide", send);

    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", send);
      // Navigation interne : la page disparaît sans jamais être « cachée ».
      send();
    };
  }, [locale, route]);

  return null;
}
