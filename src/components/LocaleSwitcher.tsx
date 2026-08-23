"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";

const LOCALES = [
  { code: "en", label: "EN" },
  { code: "fr", label: "FR" },
  { code: "zh", label: "中文" },
  { code: "km", label: "ខ្មែរ" },
] as const;

export function LocaleSwitcher({ current }: { current: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const rest = pathname.replace(/^\/(fr|en|zh|km)/, "") || "";
  const qs = search.toString();

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
