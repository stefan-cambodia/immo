"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";

const LOCALES = [
  { code: "en", label: "EN" },
  { code: "fr", label: "FR" },
  { code: "zh", label: "中文" },
  { code: "km", label: "ខ្មែរ" },
  { code: "ru", label: "РУС" },
] as const;

/**
 * Sélecteur de langue.
 *
 * Changer de langue garde la page ET ses paramètres : on ne perd pas sa
 * recherche en passant au khmer. Les paramètres demandent `useSearchParams`,
 * qui impose une frontière de suspense sur une page rendue statiquement — et
 * ce qui s'affiche en attendant décide de la mise en page. La réserve était
 * un `<span>` vide de largeur fixe, sans effet sur un élément en ligne : le
 * sélecteur surgissait à l'hydratation, faisait passer l'en-tête sur deux
 * lignes et poussait toute la page de 55 px (CLS 0,127 sur l'accueil). La
 * réserve est donc le sélecteur lui-même, sans les paramètres : mêmes liens,
 * même largeur, et rien ne bouge quand ils arrivent.
 */
export function LocaleSwitcher({ current }: { current: string }) {
  return (
    <Suspense fallback={<Links current={current} qs="" />}>
      <WithQuery current={current} />
    </Suspense>
  );
}

function WithQuery({ current }: { current: string }) {
  return <Links current={current} qs={useSearchParams().toString()} />;
}

function Links({ current, qs }: { current: string; qs: string }) {
  const pathname = usePathname();
  const rest = pathname.replace(/^\/(fr|en|zh|km|ru)(?=\/|$)/, "");

  return (
    <nav aria-label="Language" style={{ display: "flex", gap: "0.125rem", alignItems: "center" }}>
      {LOCALES.map(({ code, label }) => (
        <Link
          key={code}
          href={`/${code}${rest}${qs ? `?${qs}` : ""}`}
          lang={code === "zh" ? "zh-Hans" : code}
          onClick={() => {
            // Mémorise le choix pour les visites suivantes (lu par le middleware).
            document.cookie = `locale=${code}; path=/; max-age=31536000; samesite=lax`;
          }}
          style={{
            padding: "0.25rem 0.5rem",
            borderRadius: "0.375rem",
            fontSize: "0.8125rem",
            // « 中文 » se coupait entre ses deux caractères dans un en-tête
            // étroit : le chinois autorise la coupure partout.
            whiteSpace: "nowrap",
            fontWeight: code === current ? 700 : 500,
            color: code === current ? "var(--color-brand)" : "var(--color-ink-soft)",
            background: code === current ? "var(--color-brand-soft)" : "transparent",
          }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
