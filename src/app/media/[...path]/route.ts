import { createReadStream, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Sert les variantes du stockage local (`MEDIA_STORAGE=local`) sur le même
 * chemin public `/media/...` que produira le CDN en mode S3 : au
 * basculement, seules les variables d'environnement changent, aucune URL
 * en base ni aucun composant.
 *
 * Les fichiers sont immuables par construction (une variante se régénère
 * sous une autre clé, elle ne se réécrit pas) : cache long, `immutable`.
 */

const ROOT = resolve(process.env.MEDIA_LOCAL_DIR || "var/media");

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  // Résolution puis vérification du préfixe : la seule défense sérieuse
  // contre un chemin qui remonte, quel que soit son encodage.
  const target = resolve(join(ROOT, normalize(path.join("/"))));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const ext = target.slice(target.lastIndexOf("."));
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let size: number;
  try {
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
