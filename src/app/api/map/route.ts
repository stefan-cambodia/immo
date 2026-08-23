import { NextResponse, type NextRequest } from "next/server";
import { parseFilters, searchMapPoints } from "@/lib/search";

export async function GET(request: NextRequest) {
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  // Les valeurs répétées (type, amenity, title) doivent rester des tableaux.
  for (const key of ["type", "amenity", "title"]) {
    const all = request.nextUrl.searchParams.getAll(key);
    if (all.length > 1) (sp as Record<string, string | string[]>)[key] = all;
  }
  const points = await searchMapPoints(parseFilters(sp));
  return NextResponse.json(points, {
    headers: { "cache-control": "private, max-age=30" },
  });
}
