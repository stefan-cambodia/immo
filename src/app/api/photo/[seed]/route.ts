/**
 * Visuel de substitution pour le jeu de démonstration. En production, les
 * médias sont servis depuis un stockage S3-compatible derrière CDN, en
 * WebP/AVIF et en plusieurs tailles (§7).
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seed: string }> }
) {
  const { seed } = await params;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;

  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 22% 78%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 20% 55%)"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <g fill="hsl(${hue} 18% 40%)" opacity="0.35">
    <rect x="${120 + (h % 120)}" y="380" width="240" height="300"/>
    <rect x="${400 + (h % 90)}" y="300" width="200" height="380"/>
    <rect x="${660 + (h % 140)}" y="420" width="280" height="260"/>
  </g>
  <rect y="660" width="1200" height="140" fill="hsl(${hue} 16% 32%)" opacity="0.25"/>
</svg>`;

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
