import { NextResponse, type NextRequest } from "next/server";
import { listPartnerLocations, withPartner } from "@/lib/partner-api";

export const dynamic = "force-dynamic";

/**
 * GET /api/partner/v1/locations — référentiel des localités : hiérarchie
 * administrative complète et alias de romanisation (§5.2), pour que le
 * partenaire mappe ses libellés vers les slugs du portail.
 */
export async function GET(request: NextRequest) {
  return withPartner(request, async () => {
    return NextResponse.json({ data: await listPartnerLocations() });
  });
}
