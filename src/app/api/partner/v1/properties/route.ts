import { NextResponse, type NextRequest } from "next/server";
import { listPartnerProperties, parsePartnerFilters, withPartner } from "@/lib/partner-api";

export const dynamic = "force-dynamic";

/**
 * GET /api/partner/v1/properties — fiches agrégées, paginées par curseur.
 *
 * Filtres : transaction, type (répétable), location, foreign_eligible,
 * price_min / price_max (avec transaction), updated_since, limit, cursor.
 * Contrat détaillé dans docs/api-partenaires.md.
 */
export async function GET(request: NextRequest) {
  return withPartner(request, async () => {
    const parsed = parsePartnerFilters(request.nextUrl.searchParams);
    if ("error" in parsed) {
      return NextResponse.json(
        { error: "invalid_parameter", parameter: parsed.error },
        { status: 400 }
      );
    }
    const { data, nextCursor } = await listPartnerProperties(parsed.ok);
    return NextResponse.json({ data, next_cursor: nextCursor });
  });
}
