import { NextResponse, type NextRequest } from "next/server";
import { suggest } from "@/lib/search";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json([]);
  const items = await suggest(q, 8);
  return NextResponse.json(items, {
    headers: { "cache-control": "public, max-age=60, stale-while-revalidate=600" },
  });
}
