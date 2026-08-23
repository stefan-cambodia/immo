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
  },
};

export default config;
