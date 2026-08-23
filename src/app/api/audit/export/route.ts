import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  AUDIT_CSV_COLUMNS, auditMaxId, auditToCsvRow, countAudit, parseAuditFilters,
  recordAuditStandalone, streamAudit,
} from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Export du journal d'audit, réservé à la modération.
 *
 * Exporter un journal d'audit est en soi une action sensible : elle sort de la
 * base des adresses, des adresses IP et l'activité de toutes les agences. Elle
 * est donc journalisée comme les autres.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const format = sp.format === "jsonl" ? "jsonl" : "csv";

  // L'instantané est figé avant que l'export ne se journalise lui-même : le
  // fichier contient exactement le nombre de lignes annoncé, et pas l'entrée
  // décrivant sa propre production.
  const filters = { ...parseAuditFilters(sp), upTo: await auditMaxId() };
  const total = await countAudit(filters);

  await recordAuditStandalone(
    { id: user.id, email: user.email, role: user.role, agencyName: user.agencyName },
    {
      action: "audit_exported",
      targetType: "audit_log",
      targetLabel: `${format}:${total}`,
      details: { format, rows: total, filters },
    }
  );

  const encoder = new TextEncoder();
  const stamp = new Date().toISOString().slice(0, 10);

  const body = new ReadableStream({
    async start(controller) {
      try {
        if (format === "csv") {
          // BOM UTF-8 : sans lui, Excel abîme le khmer et le chinois.
          controller.enqueue(encoder.encode("﻿"));
          controller.enqueue(encoder.encode(AUDIT_CSV_COLUMNS.join(",") + "\r\n"));
          for await (const batch of streamAudit(filters)) {
            controller.enqueue(encoder.encode(batch.map(auditToCsvRow).join("\r\n") + "\r\n"));
          }
        } else {
          for await (const batch of streamAudit(filters)) {
            controller.enqueue(encoder.encode(batch.map((r) => JSON.stringify(r)).join("\n") + "\n"));
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/x-ndjson; charset=utf-8",
      "content-disposition":
        `attachment; filename="audit-${stamp}.${format === "csv" ? "csv" : "jsonl"}"`,
      "cache-control": "no-store",
      "x-audit-rows": String(total),
    },
  });
}
