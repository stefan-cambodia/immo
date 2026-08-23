"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Suggestion {
  kind: "location" | "building";
  slug: string;
  level: string | null;
  name: Record<string, string>;
  parentName: Record<string, string> | null;
  listingCount: number;
  score: number;
}

const field = (o: Record<string, string> | null, locale: string) =>
  o ? o[locale] || o.en || Object.values(o)[0] : "";

export function SearchBox({
  locale, placeholder, transaction = "sale", autoFocus = false, size = "md",
}: {
  locale: string; placeholder: string;
  transaction?: "sale" | "rent"; autoFocus?: boolean; size?: "md" | "lg";
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value.trim().length < 2) { setItems([]); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(value)}`, { signal: ctrl.signal });
        if (res.ok) { setItems(await res.json()); setOpen(true); setActive(-1); }
      } catch { /* requête annulée */ }
    }, 160);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [value]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (s?: Suggestion) => {
    const params = new URLSearchParams();
    if (transaction === "rent") params.set("txn", "rent");
    if (s) {
      params.set(s.kind === "location" ? "area" : "building", s.slug);
    } else if (value.trim()) {
      // Aucune suggestion retenue : la requête libre part telle quelle et sera
      // journalisée si elle ne donne rien (§10).
      params.set("q", value.trim());
    }
    router.push(`/${locale}/search?${params.toString()}`);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, -1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(active >= 0 ? items[active] : undefined); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={box} style={{ position: "relative", width: "100%" }}>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          className="field"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => items.length && setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          style={{ padding: size === "lg" ? "0.875rem 1rem" : undefined, fontSize: size === "lg" ? "1rem" : undefined }}
        />
        <button className="btn btn-primary" onClick={() => go(active >= 0 ? items[active] : undefined)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2" />
            <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open && items.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 40,
            background: "var(--color-surface)", border: "1px solid var(--color-line)",
            borderRadius: "0.625rem", boxShadow: "0 12px 32px rgb(0 0 0 / 0.12)",
            maxHeight: "22rem", overflowY: "auto",
          }}
        >
          {items.map((s, i) => (
            <li key={`${s.kind}:${s.slug}`} role="option" aria-selected={i === active}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => go(s)}
                style={{
                  display: "flex", width: "100%", gap: "0.625rem", alignItems: "center",
                  padding: "0.625rem 0.875rem", textAlign: "start",
                  background: i === active ? "var(--color-surface-alt)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <span aria-hidden style={{ color: "var(--color-ink-faint)", flexShrink: 0 }}>
                  {s.kind === "building" ? "▤" : "◎"}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600, fontSize: "0.9375rem" }}>
                    {field(s.name, locale)}
                  </span>
                  {s.parentName && (
                    <span style={{ display: "block", fontSize: "0.75rem", color: "var(--color-ink-faint)" }}>
                      {field(s.parentName, locale)}
                    </span>
                  )}
                </span>
                {s.listingCount > 0 && (
                  <span style={{ fontSize: "0.75rem", color: "var(--color-ink-faint)", flexShrink: 0 }}>
                    {s.listingCount}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
