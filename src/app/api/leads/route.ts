import { NextResponse, type NextRequest } from "next/server";
import { queryOne } from "@/lib/db";

const CHANNELS = ["phone", "telegram", "whatsapp", "wechat", "form", "email"];
const ACTIONS = ["reveal_phone", "call", "message", "form_submit", "save"];
const LOCALES = ["fr", "en", "zh", "km"];

/**
 * Journalisation des leads (§8) : qui a cliqué sur quel numéro, sur quel bien,
 * depuis quelle langue, à quelle heure. C'est la base de la facturation des
 * abonnements agences et de la vente de leads aux promoteurs.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const listingId = String(body.listingId ?? "");
  const channel = String(body.channel ?? "");
  const action = String(body.action ?? "");
  const locale = String(body.locale ?? "en");

  if (!/^[0-9a-f-]{36}$/i.test(listingId)
      || !CHANNELS.includes(channel)
      || !ACTIONS.includes(action)
      || !LOCALES.includes(locale)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const listing = await queryOne<{ property_id: string; agency_id: string; agent_id: string }>(
    `SELECT property_id, agency_id, agent_id FROM listings WHERE id = $1`,
    [listingId]
  );
  if (!listing) return NextResponse.json({ error: "unknown_listing" }, { status: 404 });

  await queryOne(
    `INSERT INTO leads(listing_id, property_id, agency_id, agent_id, channel, action_type,
                       locale, session_id, referrer, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [listingId, listing.property_id, listing.agency_id, listing.agent_id, channel, action, locale,
     request.cookies.get("sid")?.value ?? null,
     request.headers.get("referer"),
     request.headers.get("user-agent")?.slice(0, 300) ?? null]
  );

  return NextResponse.json({ ok: true });
}
