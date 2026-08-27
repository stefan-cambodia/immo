import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";

/**
 * Reçoit les mesures de terrain des navigateurs réels (§7, §10).
 *
 * Le budget de performance du brief — LCP p75 mobile sous 3 s sur 4G — ne se
 * vérifie pas en salle. Un test synthétique mesure une machine de test sur un
 * réseau de test ; la cible porte sur des téléphones d'entrée de gamme à Phnom
 * Penh. Seule la collecte côté navigateur répond à la question posée.
 *
 * Le facteur de forme est déterminé ICI, à partir des indices d'agent
 * utilisateur, et non annoncé par le client : c'est lui qui sépare le p75
 * mobile du p75 de bureau, et un client peut se tromper ou mentir.
 */

export const dynamic = "force-dynamic";

const LOCALES = ["fr", "en", "zh", "km"];
const METRICS = ["lcp", "inp", "cls", "ttfb"];
const ROUTES = ["home", "search", "property", "landing", "other"];

const BOT = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|pingdom|curl|wget|python-requests|axios|monitor/i;
const MOBILE = /android|iphone|ipad|ipod|mobile|opera mini|iemobile/i;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const metric = String(body.metric ?? "");
  const locale = String(body.locale ?? "en");
  const route = String(body.route ?? "other");
  const value = Math.round(Number(body.value));

  if (!METRICS.includes(metric) || !LOCALES.includes(locale) || !ROUTES.includes(route)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  // La contrainte existe aussi en base ; la refuser ici évite d'y écrire une
  // ligne dont on sait déjà qu'elle fausserait un centile.
  if (!Number.isFinite(value) || value < 0 || value > 120000) {
    return NextResponse.json({ error: "implausible_value" }, { status: 400 });
  }

  const ua = request.headers.get("user-agent") ?? "";
  if (!ua || BOT.test(ua)) return NextResponse.json({ ok: true, counted: false });

  await query(
    `INSERT INTO web_vitals(metric, value_ms, form_factor, locale, route)
     VALUES ($1, $2, $3, $4, $5)`,
    [metric, value, MOBILE.test(ua) ? "mobile" : "desktop", locale, route]
  );

  return NextResponse.json({ ok: true, counted: true });
}
