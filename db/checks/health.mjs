#!/usr/bin/env node
/**
 * Vérifie le point de santé /api/health.
 *
 * Ce qui compte : 200 seulement quand la base répond ET que le schéma est au
 * niveau du code ; une migration en attente donne 503 avec sa raison — c'est
 * le signal que le reverse proxy attend pour retirer l'instance ; jamais de
 * cache, jamais de secret dans la réponse.
 *
 * La migration « en attente » est simulée par un fichier vide déposé puis
 * retiré dans db/migrations : rien n'est appliqué à la base.
 *
 *   node db/checks/health.mjs [--base http://localhost:3111]
 */
import { rm, writeFile } from "node:fs/promises";
import pg from "pg";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();
const { rows: [{ name: last }] } = await db.query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`);
await db.end();

console.log("Point de santé");
const res = await fetch(`${BASE}/api/health`);
const body = await res.json();
check("200 quand tout répond", res.status === 200 && body.status === "ok" && body.db === "ok",
      JSON.stringify(body));
check("la dernière migration appliquée est nommée, aucune en attente",
      body.migration === last && body.migrationsPending === 0, `${body.migration} / ${last}`);
check("jamais mis en cache", res.headers.get("cache-control") === "no-store");
const text = JSON.stringify(body);
check("aucun secret ni détail d'hôte", !/postgres:\/\/|password|node v|\/home\//i.test(text));

const fake = "db/migrations/999_chk_health.sql";
try {
  await writeFile(fake, "-- contrôle : migration jamais appliquée\n", { flag: "wx" });
  const degraded = await fetch(`${BASE}/api/health`);
  const d = await degraded.json();
  check("une migration en attente → 503 migrations_pending",
        degraded.status === 503 && d.status === "degraded" && d.reason === "migrations_pending"
          && d.migrationsPending === 1, `${degraded.status} ${JSON.stringify(d)}`);
} finally {
  await rm(fake, { force: true });
}
const again = await fetch(`${BASE}/api/health`);
check("revenu à 200 une fois le schéma au niveau", again.status === 200);

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
