import "server-only";
import { headers } from "next/headers";
import { pool, query, type PoolClient } from "./db";
import type { SessionUser } from "./auth";

export const AUDIT_ACTIONS = [
  "sign_in", "sign_out", "property_created", "listing_confirmed",
  "dedup_merged", "dedup_distinct", "alias_added", "translation_reviewed",
  "audit_exported", "audit_purged",
  "tier_changed", "invoice_issued", "invoice_paid", "invoice_voided",
  "listing_featured", "listing_unfeatured", "verification_changed",
  "title_verification_requested", "title_verification_step",
  "title_verification_concluded",
  "api_partner_created", "api_key_issued", "api_key_revoked",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTarget =
  | "session" | "property" | "listing" | "location" | "dedup_candidate" | "audit_log"
  | "agency" | "invoice" | "title_verification" | "api_partner" | "api_key";

export interface AuditEntry {
  action: AuditAction;
  targetType: AuditTarget;
  /** Identifiant technique de la cible, quand elle en a un. */
  targetId?: string | null;
  /** Libellé lisible figé au moment de l'action : référence du bien, slug de
   *  localité… Il doit rester compréhensible après suppression de la cible. */
  targetLabel?: string | null;
  details?: Record<string, unknown>;
}

/** Auteur de l'action, réduit à ce que le journal conserve. */
export interface AuditActor {
  id: string | null;
  email: string;
  role: "admin" | "agency";
  agencyName: string | null;
}

export function actorFromUser(user: SessionUser): AuditActor {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    agencyName: user.agencyName,
  };
}

async function clientMeta() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  };
}

const INSERT = `
  INSERT INTO audit_log(actor_user_id, actor_email, actor_role, actor_agency,
                        action, target_type, target_id, target_label,
                        details, ip, user_agent)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

/**
 * Écrit une entrée de journal **dans la transaction en cours**.
 *
 * L'appelant passe le client de la transaction qui porte la mutation : si
 * l'écriture du journal échoue, la mutation est annulée avec elle. C'est tout
 * l'intérêt — un journal qu'on peut perdre en cas d'incident ne prouve rien.
 */
export async function recordAudit(
  client: PoolClient,
  actor: AuditActor,
  entry: AuditEntry
): Promise<void> {
  const { ip, userAgent } = await clientMeta();
  await client.query(INSERT, [
    actor.id, actor.email, actor.role, actor.agencyName,
    entry.action, entry.targetType, entry.targetId ?? null, entry.targetLabel ?? null,
    JSON.stringify(entry.details ?? {}), ip, userAgent,
  ]);
}

/**
 * Variante hors transaction, pour les événements qui n'accompagnent aucune
 * mutation métier — connexion, déconnexion. Une trace manquante y est un
 * désagrément, pas une incohérence.
 */
export async function recordAuditStandalone(
  actor: AuditActor,
  entry: AuditEntry
): Promise<void> {
  const { ip, userAgent } = await clientMeta();
  await pool.query(INSERT, [
    actor.id, actor.email, actor.role, actor.agencyName,
    entry.action, entry.targetType, entry.targetId ?? null, entry.targetLabel ?? null,
    JSON.stringify(entry.details ?? {}), ip, userAgent,
  ]);
}

// ---------------------------------------------------------------------------
// Consultation et export
// ---------------------------------------------------------------------------

export interface AuditFilters {
  from: string | null;   // ISO 8601, borne incluse
  to: string | null;     // ISO 8601, borne exclue (fin de journée côté UI)
  action: AuditAction | null;
  actor: string | null;
  /** Identifiant maximal retenu. Fixé au début d'un export pour qu'il porte
   *  sur un instantané figé : sans cela l'entrée `audit_exported` créée par
   *  l'export apparaîtrait dans son propre résultat, et le nombre de lignes
   *  annoncé ne correspondrait plus au fichier. */
  upTo?: string | null;
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export function parseAuditFilters(
  sp: Record<string, string | string[] | undefined>,
  prefix = "audit_"
): AuditFilters {
  const one = (k: string) => {
    const v = sp[`${prefix}${k}`];
    const s = Array.isArray(v) ? v[0] : v;
    return s?.trim() || null;
  };
  const action = one("action");
  const from = one("from");
  const to = one("to");
  return {
    from: from && isDate(from) ? from : null,
    to: to && isDate(to) ? to : null,
    action: action && (AUDIT_ACTIONS as readonly string[]).includes(action)
      ? (action as AuditAction) : null,
    actor: one("actor")?.slice(0, 200) ?? null,
  };
}

export function auditFiltersToQuery(f: AuditFilters, prefix = "audit_"): string {
  const p = new URLSearchParams();
  if (f.from) p.set(`${prefix}from`, f.from);
  if (f.to) p.set(`${prefix}to`, f.to);
  if (f.action) p.set(`${prefix}action`, f.action);
  if (f.actor) p.set(`${prefix}actor`, f.actor);
  return p.toString();
}

/** Construit la clause WHERE partagée par l'affichage et l'export : les deux
 *  doivent porter exactement sur le même ensemble de lignes. */
function auditWhere(f: AuditFilters, params: unknown[]): string {
  const clauses: string[] = ["true"];
  if (f.from) { params.push(f.from); clauses.push(`created_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); clauses.push(`created_at < ($${params.length}::date + 1)`); }
  if (f.action) { params.push(f.action); clauses.push(`action = $${params.length}::audit_action`); }
  if (f.actor) { params.push(`%${f.actor}%`); clauses.push(`actor_email ILIKE $${params.length}`); }
  if (f.upTo) { params.push(f.upTo); clauses.push(`id <= $${params.length}::bigint`); }
  return clauses.join(" AND ");
}

export interface AuditRecord {
  id: string;
  actorEmail: string;
  actorRole: "admin" | "agency";
  actorAgency: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

const SELECT_COLUMNS = `
  id::text, actor_email AS "actorEmail", actor_role AS "actorRole",
  actor_agency AS "actorAgency", action::text, target_type::text AS "targetType",
  target_id AS "targetId", target_label AS "targetLabel", details,
  ip, user_agent AS "userAgent", created_at AS "createdAt"`;

export async function listAudit(f: AuditFilters, limit = 50): Promise<AuditRecord[]> {
  const params: unknown[] = [];
  const where = auditWhere(f, params);
  params.push(limit);
  return query<AuditRecord>(
    `SELECT ${SELECT_COLUMNS} FROM audit_log WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
}

export async function countAudit(f: AuditFilters): Promise<number> {
  const params: unknown[] = [];
  const where = auditWhere(f, params);
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE ${where}`, params);
  return Number(rows[0].n);
}

/** Statistiques de rétention affichées à côté du journal. */
/** Identifiant le plus élevé du journal, pour figer un export. */
export async function auditMaxId(): Promise<string | null> {
  const rows = await query<{ id: string | null }>(`SELECT max(id)::text AS id FROM audit_log`);
  return rows[0].id;
}

export async function auditSpan(): Promise<{
  total: number; oldest: string | null; newest: string | null; purges: number;
}> {
  const rows = await query<{ n: string; oldest: string | null; newest: string | null; purges: string }>(
    `SELECT count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest,
            count(*) FILTER (WHERE action = 'audit_purged') AS purges
     FROM audit_log`);
  return {
    total: Number(rows[0].n),
    oldest: rows[0].oldest,
    newest: rows[0].newest,
    purges: Number(rows[0].purges),
  };
}

/**
 * Parcourt le journal filtré par lots, pour un export qui ne charge jamais la
 * totalité en mémoire. La pagination est faite sur `id`, stable et indexé.
 */
export async function* streamAudit(
  f: AuditFilters, batchSize = 500
): AsyncGenerator<AuditRecord[]> {
  let after: string | null = null;
  for (;;) {
    const params: unknown[] = [];
    const where = auditWhere(f, params);
    let cursor = "";
    if (after) { params.push(after); cursor = ` AND id < $${params.length}::bigint`; }
    params.push(batchSize);
    const rows: AuditRecord[] = await query<AuditRecord>(
      `SELECT ${SELECT_COLUMNS} FROM audit_log WHERE ${where}${cursor}
       ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    after = rows[rows.length - 1].id;
  }
}

export const AUDIT_CSV_COLUMNS = [
  "id", "created_at", "actor_email", "actor_role", "actor_agency", "action",
  "target_type", "target_id", "target_label", "ip", "user_agent", "details",
] as const;

/**
 * Échappement CSV. Le préfixe apostrophe sur `= + - @ tab CR` n'est pas de la
 * cosmétique : `details` contient des termes de recherche saisis par des
 * visiteurs (via `search_misses`), et un tableur interprète une cellule qui
 * commence par `=` comme une formule.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s =
    value instanceof Date ? value.toISOString()
    : typeof value === "object" ? JSON.stringify(value)
    : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function auditToCsvRow(r: AuditRecord): string {
  return [
    r.id, r.createdAt, r.actorEmail, r.actorRole, r.actorAgency, r.action,
    r.targetType, r.targetId, r.targetLabel, r.ip, r.userAgent, r.details,
  ].map(csvCell).join(",");
}
