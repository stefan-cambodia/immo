import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

const LOCALES = ["fr", "en", "zh", "km"];

// Les robots consultent beaucoup et ne contactent jamais : les compter
// gonflerait les vues sans gonfler les leads, donc écraserait le taux de
// contact que les agences regardent.
const BOT = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|pingdom|curl|wget|python-requests|axios|monitor/i;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const propertyId = String(body.propertyId ?? "");
  const locale = String(body.locale ?? "en");
  if (!/^[0-9a-f-]{36}$/i.test(propertyId) || !LOCALES.includes(locale)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const ua = request.headers.get("user-agent") ?? "";
  if (!ua || BOT.test(ua)) return NextResponse.json({ ok: true, counted: false });

  // Identifiant de session opaque, posé par le client. Il ne sert qu'au
  // dédoublonnage horaire et n'est rattaché à aucune identité.
  const session = String(body.session ?? "").slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(session)) {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  let referrerHost: string | null = null;
  const referrer = request.headers.get("referer");
  if (referrer) {
    try { referrerHost = new URL(referrer).host.slice(0, 120); } catch { /* ignoré */ }
  }

  await query(
    `INSERT INTO property_views(property_id, session_id, locale, referrer_host)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (property_id, session_id, hour_bucket) DO NOTHING`,
    [propertyId, session, locale, referrerHost]
  );

  return NextResponse.json({ ok: true, counted: true });
}
