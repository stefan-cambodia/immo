import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { query } from "@/lib/db";

/**
 * Point de santé pour le reverse proxy, l'ordonnanceur et la supervision.
 *
 * Répond 200 quand l'application ET la base répondent, et que le schéma
 * est au niveau du code — une migration en attente est un déploiement à
 * moitié fait, pas un état sain. Sinon 503, avec la raison : c'est un
 * signal pour retirer l'instance du trafic, pas un rapport détaillé —
 * rien ici n'est secret (pas d'URL de base, pas de version de Node).
 */
export const dynamic = "force-dynamic";

const started = Date.now();
const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

export async function GET() {
  const body: Record<string, unknown> = {
    status: "ok",
    db: "ok",
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
  };
  let status = 200;

  try {
    const [applied, files] = await Promise.all([
      query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`),
      readdir(MIGRATIONS_DIR).then((f) => f.filter((n) => n.endsWith(".sql")).sort(), () => null),
    ]);
    body.migration = applied.at(-1)?.name ?? null;
    if (files) {
      const done = new Set(applied.map((m) => m.name));
      const pending = files.filter((f) => !done.has(f));
      body.migrationsPending = pending.length;
      if (pending.length > 0) {
        body.status = "degraded";
        body.reason = "migrations_pending";
        status = 503;
      }
    }
  } catch {
    body.status = "degraded";
    body.db = "error";
    body.reason = "database_unreachable";
    status = 503;
  }

  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
