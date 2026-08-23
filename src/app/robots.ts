import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/api/", "/*/backoffice"] },
      // Baidu et Sogou comptent autant que Google pour l'audience chinoise (§4.3).
      { userAgent: ["Baiduspider", "Sogou web spider"], allow: "/zh/" },
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
