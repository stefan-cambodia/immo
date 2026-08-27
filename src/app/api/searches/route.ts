import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";

/**
 * Journalise une recherche en texte libre — aboutie ou non.
 *
 * C'est le dénominateur qui manquait au taux de recherches sans résultat
 * (§10). `search_misses` ne retient que les échecs, ce qui suffit à nourrir la
 * table d'alias mais ne fait pas un taux.
 *
 * Côté client, comme la mesure d'audience, et pour la même raison : la page de
 * résultats est un rendu serveur, et un rendu n'est pas une recherche — la
 * pagination, un rechargement ou un préchargement en produisent sans que
 * personne n'ait cherché quoi que ce soit.
 *
 * Le texte de la requête n'est PAS conservé : le serveur en prend une
 * empreinte, qui suffit à ne pas compter dix fois la même recherche affinée
 * filtre par filtre. Le texte des recherches qui échouent est déjà gardé, lui,
 * par `search_misses` — c'est là qu'il a un usage.
 */

export const dynamic = "force-dynamic";

const LOCALES = ["fr", "en", "zh", "km"];

// Même liste que la mesure d'audience : un robot qui balaie les pages de
// résultats gonflerait le dénominateur et ferait passer le taux d'échec pour
// meilleur qu'il n'est.
const BOT = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|pingdom|curl|wget|python-requests|axios|monitor/i;

/** Même normalisation que la résolution d'alias : casse et espaces ne font pas deux recherches. */
const fingerprint = (q: string) =>
  createHash("sha256").update(q.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 32);

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const q = String(body.q ?? "").slice(0, 200);
  const locale = String(body.locale ?? "en");
  if (!q.trim() || !LOCALES.includes(locale)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const ua = request.headers.get("user-agent") ?? "";
  if (!ua || BOT.test(ua)) return NextResponse.json({ ok: true, counted: false });

  const session = String(body.session ?? "").slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(session)) {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  await query(
    `INSERT INTO search_events(session_id, locale, resolved, query_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, query_hash, day_bucket) DO NOTHING`,
    [session, locale, body.resolved === true, fingerprint(q)]
  );

  return NextResponse.json({ ok: true, counted: true });
}
