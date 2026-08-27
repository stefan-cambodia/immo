"use client";

import { useState } from "react";

// Tout contact est journalisé : sans cela rien n'est facturable ni démontrable
// auprès des agences et des promoteurs (§8).
async function trackLead(payload: {
  listingId: string; channel: string; action: string; locale: string;
}) {
  try {
    await fetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch { /* la journalisation ne doit jamais bloquer le contact */ }
}

export function ContactAgent({
  listingId, locale, phone, telegram, wechat, sourceUrl, labels,
}: {
  listingId: string;
  locale: string;
  phone: string;
  telegram: string | null;
  wechat: string | null;
  /** Annonce d'origine, pour les annonces collectées sur un portail (§6.1). */
  sourceUrl?: string | null;
  labels: { reveal: string; call: string; telegram: string; wechat: string; source: string };
}) {
  const [revealed, setRevealed] = useState(false);

  const masked = phone.replace(/\d(?=\d{3})/g, "•");
  // Une annonce collectée n'apporte aucun numéro : les pages sources exposent
  // des coordonnées personnelles qui n'ont pas à entrer chez nous. La voie de
  // contact est alors l'annonce d'origine, et le clic n'est pas compté comme
  // un contact — ce n'en est pas un pour nous.
  const dialable = /\d/.test(phone);

  if (!dialable) {
    return sourceUrl ? (
      <a className="btn btn-primary" href={sourceUrl} target="_blank" rel="noopener nofollow">
        {labels.source} ↗
      </a>
    ) : null;
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      {!revealed ? (
        <button
          className="btn btn-primary"
          onClick={() => {
            setRevealed(true);
            trackLead({ listingId, channel: "phone", action: "reveal_phone", locale });
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M3 2h3l1.5 3.5L6 7a8 8 0 0 0 3 3l1.5-1.5L14 10v3a1 1 0 0 1-1 1A11 11 0 0 1 2 3a1 1 0 0 1 1-1Z"
                  stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          {labels.reveal} · {masked}
        </button>
      ) : (
        <a
          className="btn btn-primary"
          href={`tel:${phone.replace(/\s/g, "")}`}
          onClick={() => trackLead({ listingId, channel: "phone", action: "call", locale })}
        >
          {phone}
        </a>
      )}

      {telegram && (
        <a
          className="btn btn-outline"
          href={`https://t.me/${telegram.replace("@", "")}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackLead({ listingId, channel: "telegram", action: "message", locale })}
        >
          {labels.telegram}
        </a>
      )}

      {wechat && (
        <button
          className="btn btn-outline"
          onClick={() => {
            navigator.clipboard?.writeText(wechat).catch(() => {});
            trackLead({ listingId, channel: "wechat", action: "message", locale });
          }}
          title={wechat}
        >
          {labels.wechat} · {wechat}
        </button>
      )}
    </div>
  );
}
