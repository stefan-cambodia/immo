import type { MetadataRoute } from "next";
import { query } from "@/lib/db";
import { LOCALES } from "@/lib/i18n";
import { indexableCombos, landingPath } from "@/lib/seo";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Sans cette directive, Next pré-rend le sitemap UNE fois, à `next build`, et
// le sert figé jusqu'à la construction suivante : une page d'atterrissage qui
// franchit le seuil n'y entrerait jamais, une qui repasse dessous y resterait
// annoncée en `noindex` — l'invariant que `npm run check:seo` protège ne
// tiendrait qu'à la sortie du build. Régénéré au plus toutes les heures, le
// rythme du cycle d'expiration des annonces (ops/expire-listings.sh).
export const revalidate = 3600;

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

  // Projets et promoteurs : peu d'URLs, contenu propre à chacune — tous
  // indexables, sans seuil (voir src/lib/projects.ts).
  const projects = await query<{ slug: string }>(`SELECT slug FROM buildings ORDER BY slug`);
  const developers = await query<{ slug: string }>(
    `SELECT d.slug FROM developers d WHERE EXISTS
       (SELECT 1 FROM buildings b WHERE b.developer_id = d.id) ORDER BY d.slug`);

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
    {
      url: `${SITE}/en/projects`,
      changeFrequency: "daily" as const,
      priority: 0.8,
      alternates: alt("/projects"),
    },
    {
      url: `${SITE}/en/estimate`,
      changeFrequency: "weekly" as const,
      priority: 0.8,
      alternates: alt("/estimate"),
    },
    ...projects.map((b) => ({
      url: `${SITE}/en/project/${b.slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.6,
      alternates: alt(`/project/${b.slug}`),
    })),
    ...developers.map((d) => ({
      url: `${SITE}/en/developer/${d.slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.5,
      alternates: alt(`/developer/${d.slug}`),
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
