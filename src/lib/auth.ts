import "server-only";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { query, queryOne } from "./db";
import { recordAuditStandalone } from "./audit";

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "bo_session";
const SESSION_DAYS = 7;
const SCRYPT_KEYLEN = 64;

// Fenêtre et seuil de limitation des tentatives de connexion.
const ATTEMPT_WINDOW = "15 minutes";
const MAX_ATTEMPTS = 5;

export type Role = "admin" | "agency";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  agencyId: string | null;
  agencyName: string | null;
}

// ---------------------------------------------------------------------------
// Mots de passe
// ---------------------------------------------------------------------------

/** Format stocké : `scrypt$<sel hex>$<clé hex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Hachage de référence utilisé quand l'adresse est inconnue : la vérification
// coûte alors le même temps qu'un échec de mot de passe, et l'attaquant ne peut
// pas distinguer « compte inexistant » de « mot de passe faux ».
const DECOY_HASH =
  "scrypt$00000000000000000000000000000000$" + "00".repeat(SCRYPT_KEYLEN);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

async function clientMeta() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  };
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const { ip, userAgent } = await clientMeta();

  await query(
    `INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)`,
    [hashToken(token), userId, SESSION_DAYS, ip, userAgent]
  );
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);

  // Savoir qui était connecté, et quand, fait partie de la piste d'audit :
  // sans cela une action anonymisée par la suppression d'un compte n'est plus
  // rattachable à une session. Les échecs restent dans `login_attempts`.
  const actor = await queryOne<{
    id: string; email: string; role: Role; agencyName: string | null;
  }>(
    `SELECT u.id, u.email, u.role, a.name AS "agencyName"
     FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.id = $1`,
    [userId]
  );
  if (actor) {
    await recordAuditStandalone(actor, { action: "sign_in", targetType: "session" });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const user = await getCurrentUser();
    await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
    if (user) {
      await recordAuditStandalone(
        { id: user.id, email: user.email, role: user.role, agencyName: user.agencyName },
        { action: "sign_out", targetType: "session" }
      );
    }
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Lit la session courante. Mis en cache pour la durée du rendu : la garde de
 * layout, la page et une action peuvent l'appeler sans multiplier les requêtes.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await queryOne<{
    id: string; email: string; name: string; role: Role;
    agencyId: string | null; agencyName: string | null;
  }>(
    `SELECT u.id, u.email, u.name, u.role, u.agency_id AS "agencyId",
            a.name AS "agencyName"
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN agencies a ON a.id = u.agency_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [hashToken(token)]
  );
  if (!row) return null;

  // Trace de dernière activité, utile pour révoquer une session suspecte.
  await query(
    `UPDATE sessions SET last_seen_at = now()
     WHERE token_hash = $1 AND last_seen_at < now() - interval '5 minutes'`,
    [hashToken(token)]
  ).catch(() => {});

  return row;
});

// ---------------------------------------------------------------------------
// Gardes
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(public readonly reason: "unauthenticated" | "forbidden") {
    super(reason);
  }
}

/**
 * À appeler en tête de CHAQUE action serveur du back-office. Une action est un
 * point d'entrée POST à part entière : elle reste atteignable même si la page
 * qui la contient n'a jamais été rendue, donc la garde de layout ne la protège
 * pas.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("unauthenticated");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new AuthError("forbidden");
  return user;
}

/** Une agence n'agit que sur ses propres annonces ; un admin sur toutes. */
export function assertOwnsAgency(user: SessionUser, agencyId: string): void {
  if (user.role === "admin") return;
  if (user.agencyId !== agencyId) throw new AuthError("forbidden");
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------

export interface LoginOutcome {
  ok: boolean;
  reason?: "invalid_credentials" | "rate_limited";
  userId?: string;
  /** Le mot de passe est bon mais le compte exige un code TOTP : pas de
   *  session tant que le second facteur n'est pas passé. */
  secondFactor?: boolean;
}

/** La limitation des tentatives, partagée entre le mot de passe et le code
 *  TOTP : un code se devine par force brute exactement comme un mot de passe. */
export async function isLoginBlocked(emailRaw: string): Promise<boolean> {
  const email = emailRaw.trim().toLowerCase();
  const { ip } = await clientMeta();
  const [{ blocked }] = await query<{ blocked: boolean }>(
    `SELECT (
       (SELECT count(*) FROM login_attempts
         WHERE NOT successful AND email = $1
           AND created_at > now() - $3::interval) >= $4
       OR
       ($2::text IS NOT NULL AND (SELECT count(*) FROM login_attempts
         WHERE NOT successful AND ip = $2
           AND created_at > now() - $3::interval) >= $4 * 4)
     ) AS blocked`,
    [email, ip, ATTEMPT_WINDOW, MAX_ATTEMPTS]
  );
  return blocked;
}

export async function recordLoginAttempt(emailRaw: string, successful: boolean): Promise<void> {
  const { ip } = await clientMeta();
  await query(
    `INSERT INTO login_attempts(email, ip, successful) VALUES ($1, $2, $3)`,
    [emailRaw.trim().toLowerCase(), ip, successful]
  );
}

export async function attemptLogin(emailRaw: string, password: string): Promise<LoginOutcome> {
  const email = emailRaw.trim().toLowerCase();

  if (await isLoginBlocked(email)) return { ok: false, reason: "rate_limited" };

  const user = await queryOne<{ id: string; password_hash: string; totp: boolean }>(
    `SELECT id, password_hash, totp_enabled_at IS NOT NULL AS totp
     FROM users WHERE lower(email) = $1 AND active`,
    [email]
  );

  // Vérification menée même sans compte correspondant : temps de réponse
  // constant, pas d'énumération des comptes.
  const valid = await verifyPassword(password, user?.password_hash ?? DECOY_HASH);
  const ok = Boolean(user) && valid;

  // Avec second facteur, la tentative ne compte comme réussie qu'une fois le
  // code passé : l'étape TOTP enregistre la sienne.
  if (!user?.totp || !ok) await recordLoginAttempt(email, ok);

  return ok
    ? { ok: true, userId: user!.id, secondFactor: user!.totp }
    : { ok: false, reason: "invalid_credentials" };
}
