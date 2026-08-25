import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Le projet est autonome : ne pas remonter au lockfile du dossier parent.
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  experimental: {
    // Keep the initial JS bundle under the 200 kB budget (§7).
    optimizePackageImports: ["maplibre-gl"],
    // La création d'un bien accepte des photos jointes (§7) : la limite par
    // défaut d'une action serveur (1 Mo) refuserait la première photo.
    // 20 photos × 12 Mo au plus, cf. db/lib/media-upload.mjs.
    serverActions: { bodySizeLimit: "250mb" },
  },
};

export default config;
