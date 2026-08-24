import { NextResponse, type NextRequest } from "next/server";
import { getPartnerProperty, withPartner } from "@/lib/partner-api";

export const dynamic = "force-dynamic";

/**
 * GET /api/partner/v1/properties/{reference} — fiche complète d'un bien :
 * la fiche agrégée, le détail des annonces actives (agence, prix,
 * description) et les médias. Jamais de coordonnées d'agent.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  return withPartner(request, async () => {
    const { reference } = await params;
    const property = await getPartnerProperty(reference);
    if (!property) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(property);
  });
}
