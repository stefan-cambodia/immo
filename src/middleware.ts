import { NextResponse, type NextRequest } from "next/server";

const LOCALES = ["fr", "en", "zh", "km"];

// Dupliqué depuis lib/auth : le middleware ne doit pas importer de code serveur.
const SESSION_COOKIE = "bo_session";

/** Négociation minimale, dupliquée depuis lib/i18n : le middleware tourne
 *  sur le runtime edge et ne doit pas tirer le code serveur. */
function negotiate(header: string | null): string {
  if (!header) return "en";
  const ranked = header.split(",")
    .map((p) => {
      const [tag, q] = p.trim().split(";q=");
      return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("km")) return "km";
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasLocale = LOCALES.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`)
  );

  if (hasLocale) {
    // Renvoi immédiat vers la connexion quand aucun cookie de session n'est
    // présent : cela évite un aller-retour, rien de plus. La vérification qui
    // fait autorité est faite côté serveur (layout du back-office et gardes
    // des actions) — le middleware tourne sur le runtime edge et ne peut pas
    // interroger la base, il ne sait donc pas si le jeton est valide.
    const locale = pathname.split("/")[1];
    if (pathname.startsWith(`/${locale}/backoffice`)
        && !request.cookies.has(SESSION_COOKIE)) {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/login`;
      url.search = `?next=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  const cookie = request.cookies.get("locale")?.value;
  const locale = cookie && LOCALES.includes(cookie)
    ? cookie
    : negotiate(request.headers.get("accept-language"));

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)"],
};
