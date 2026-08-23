import type { MetadataRoute } from "next";
import { query } from "@/lib/db";
import { LOCALES } from "@/lib/i18n";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Sitemap multilingue avec alternates par locale. Le SEO multilingue est un
 * canal d'acquisition majeur (principe n°5) : chaque fiche existe dans les
 * quatre langues et se déclare comme telle.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const properties = await query<{ reference: string; updatedAt: string }>(
    `SELECT p.reference, max(l.updated_at) AS "updatedAt"
     FROM properties p JOIN listings l ON l.property_id = p.id AND l.status = 'active'
     GROUP BY p.reference LIMIT 40000`
  );
  const areas = await query<{ slug: string }>(
    `SELECT slug FROM locations WHERE listing_count > 0`
  );

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
    ...areas.map((a) => ({
      url: `${SITE}/en/search?area=${a.slug}`,
      changeFrequency: "daily" as const,
      priority: 0.8,
      alternates: alt(`/search?area=${a.slug}`),
    })),
    ...properties.map((p) => ({
      url: `${SITE}/en/property/${p.reference}`,
      lastModified: new Date(p.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.7,
      alternates: alt(`/property/${p.reference}`),
    })),
  ];
}
