import type { MetadataRoute } from "next";
import { query } from "@/lib/db";
import { LOCALES } from "@/lib/i18n";
import { indexableCombos, landingPath } from "@/lib/seo";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Sitemap multilingue avec alternates par locale. Le SEO multilingue est un
 * canal d'acquisition majeur (principe n°5) : chaque fiche existe dans les
 * quatre langues et se déclare comme telle.
 *
 * Les pages d'atterrissage n'y figurent que si elles franchissent le seuil
 * d'inventaire — le sitemap et la balise `robots` doivent porter sur
 * exactement le même ensemble, sinon on annonce à Google des pages qu'on lui
 * demande par ailleurs d'ignorer.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const properties = await query<{ reference: string; updatedAt: string }>(
    `SELECT p.reference, max(l.updated_at) AS "updatedAt"
     FROM properties p JOIN listings l ON l.property_id = p.id AND l.status = 'active'
     GROUP BY p.reference LIMIT 40000`
  );
  const combos = await indexableCombos();

  const alt = (path: string) => ({
    languages: Object.fromEntries(LOCALES.map((l) => [l, `${SITE}/${l}${path}`])),
  });

  return [
    ...LOCALES.map((l) => ({
      url: `${SITE}/${l}`,
      changeFrequency: "daily" as const,
      priority: 1,
      alternates: alt(""),
    })),
    ...combos.map((c) => {
      const scope = { transaction: c.segment === "rent" ? "rent" as const : "sale" as const,
                      segment: c.segment, areaSlug: c.areaSlug, typeSlug: c.typeSlug };
      const path = landingPath("en", scope).replace(/^\/en/, "");
      return {
        url: `${SITE}${landingPath("en", scope)}`,
        changeFrequency: "daily" as const,
        // Une page qui porte plus d'inventaire mérite d'être explorée plus
        // souvent : la priorité suit le nombre de biens, plafonnée.
        priority: Math.min(0.9, 0.5 + c.n / 100),
        alternates: alt(path),
      };
    }),
    ...properties.map((p) => ({
      url: `${SITE}/en/property/${p.reference}`,
      lastModified: new Date(p.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.7,
      alternates: alt(`/property/${p.reference}`),
    })),
  ];
}
