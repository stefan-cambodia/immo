#!/usr/bin/env node
/**
 * Vérifie la gestion des comptes (invitations, réinitialisations).
 *
 * Ce qui compte : un compte créé est inerte tant que l'invitation n'est pas
 * consommée, un jeton ne sert qu'une fois, la réinitialisation coupe les
 * sessions, la désactivation coupe tout, la limitation tient — et les pages
 * publiques ne confirment jamais qu'un compte existe.
 *
 * La partie base tourne dans une transaction annulée à la fin ; la partie
 * HTTP crée un jeton committé, interroge le serveur de développement, puis
 * nettoie.
 *
 *   node db/checks/accounts.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { consumeTokenAndSetPassword, createAccount, generateAccountToken,
         issueToken, listAccounts, peekToken, requestReset, resetRateLimited,
         setAccountActive, RESET_MAX_PER_EMAIL } from "../lib/accounts.mjs";

const scrypt = promisify(scryptCb);
const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
};

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

// ------------------------------------------------------- Cycle d'invitation
console.log("Invitation");
await db.query("BEGIN");

const { rows: [agency] } = await db.query(`SELECT id FROM agencies LIMIT 1`);
const account = await createAccount(db, {
  email: "CHK-Invite@Example.org", name: "Compte de contrôle",
  role: "agency", agencyId: agency.id });
check("le compte se crée, adresse normalisée en minuscules",
      account?.email === "chk-invite@example.org", JSON.stringify(account));
check("l'adresse déjà prise est refusée sans erreur",
      (await createAccount(db, { email: "chk-invite@example.org", name: "Doublon",
                                 role: "agency", agencyId: agency.id })) === null);

const { rows: [inert] } = await db.query(
  `SELECT password_hash LIKE 'scrypt$000%' AS decoy FROM users WHERE id = $1`, [account.id]);
check("le compte est inerte : hachage leurre, jamais dérivé d'un texte", inert.decoy === true);

const invite = await issueToken(db, {
  userId: account.id, purpose: "invite", createdBy: "chk@khmerestate.kh" });
check("l'invitation s'émet avec sa valeur en clair", typeof invite?.token === "string");
const { rows: [storedTok] } = await db.query(
  `SELECT token_hash FROM account_tokens WHERE id = $1`, [invite.tokenId]);
check("la base ne garde que le hachage du jeton",
      storedTok.token_hash !== invite.token && storedTok.token_hash.length === 64);

const peeked = await peekToken(db, invite.token);
check("le jeton se regarde sans se consommer",
      peeked?.purpose === "invite" && peeked?.email === account.email
        && (await peekToken(db, invite.token)) !== null);
check("un jeton inconnu ne montre rien", (await peekToken(db, "pas-un-jeton")) === null);

const second = await issueToken(db, { userId: account.id, purpose: "invite" });
check("une nouvelle invitation invalide la précédente",
      (await peekToken(db, invite.token)) === null && (await peekToken(db, second.token)) !== null);

const consumed = await consumeTokenAndSetPassword(db, {
  token: second.token, passwordHash: await hashPassword("mot-de-passe-solide") });
check("la consommation pose le mot de passe et identifie le compte",
      consumed?.userId === account.id && consumed?.purpose === "invite"
        && consumed?.role === "agency" && Boolean(consumed?.agencyName),
      JSON.stringify(consumed));
check("un jeton ne sert qu'une fois",
      (await consumeTokenAndSetPassword(db, {
        token: second.token, passwordHash: await hashPassword("autre") })) === null);

const { rows: [afterInvite] } = await db.query(
  `SELECT password_hash LIKE 'scrypt$000%' AS decoy FROM users WHERE id = $1`, [account.id]);
check("le hachage leurre a été remplacé", afterInvite.decoy === false);

// Jeton périmé : forcé en base, refusé partout.
const expired = await issueToken(db, { userId: account.id, purpose: "reset" });
await db.query(`UPDATE account_tokens SET expires_at = now() - interval '1 minute'
                WHERE id = $1`, [expired.tokenId]);
check("un jeton périmé est refusé",
      (await peekToken(db, expired.token)) === null
        && (await consumeTokenAndSetPassword(db, {
             token: expired.token, passwordHash: await hashPassword("x".repeat(12)) })) === null);

// -------------------------------------------------------- Réinitialisation
console.log("Réinitialisation");
await db.query(
  `INSERT INTO sessions(token_hash, user_id, expires_at)
   VALUES ('chk-session-hash', $1, now() + interval '1 day')`, [account.id]);

const reset = await requestReset(db, { email: "chk-invite@example.org", ip: "203.0.113.7" });
check("la demande émet un jeton pour un compte actif", typeof reset?.token === "string");
check("une adresse inconnue est journalisée mais n'émet rien",
      (await requestReset(db, { email: "inconnu@example.org", ip: "203.0.113.7" })) === null);
const { rows: [reqLog] } = await db.query(
  `SELECT count(*) FILTER (WHERE known) AS known,
          count(*) FILTER (WHERE NOT known) AS unknown
   FROM password_reset_requests WHERE ip = '203.0.113.7'`);
check("la table des demandes garde la différence connue/inconnue",
      reqLog.known === "1" && reqLog.unknown === "1", JSON.stringify(reqLog));

await consumeTokenAndSetPassword(db, {
  token: reset.token, passwordHash: await hashPassword("nouveau-mot-de-passe") });
const { rows: sessions } = await db.query(
  `SELECT 1 FROM sessions WHERE user_id = $1`, [account.id]);
check("la réinitialisation coupe toutes les sessions du compte", sessions.length === 0);

for (let i = 0; i < RESET_MAX_PER_EMAIL; i++) {
  await db.query(`INSERT INTO password_reset_requests(email, ip, known)
                  VALUES ('chk-limite@example.org', '203.0.113.8', false)`);
}
check("la limitation par adresse tient (3/heure)",
      (await resetRateLimited(db, { email: "chk-limite@example.org", ip: null })) === true
        && (await resetRateLimited(db, { email: "chk-autre@example.org", ip: "203.0.113.9" })) === false);

// ------------------------------------------------------------ Désactivation
console.log("Désactivation");
const reopened = await issueToken(db, { userId: account.id, purpose: "reset" });
const off = await setAccountActive(db, account.id, false);
check("la désactivation répond le compte", off?.email === account.email);
check("elle invalide les jetons ouverts", (await peekToken(db, reopened.token)) === null);
check("un compte désactivé n'émet plus de jeton",
      (await issueToken(db, { userId: account.id, purpose: "reset" })) === null
        && (await requestReset(db, { email: "chk-invite@example.org", ip: null })) === null);
check("la désactivation est idempotente", (await setAccountActive(db, account.id, false)) === null);
const listed = (await listAccounts(db)).find((a) => a.id === account.id);
check("le panneau liste le compte avec son état", listed?.active === false);

await db.query("ROLLBACK");

// ------------------------------------------------------------ Pages publiques
console.log("\nPages publiques");
// Jeton committé : le serveur de développement lit la même base mais pas la
// même transaction.
const { token: httpToken, hash: httpHash } = generateAccountToken();
const { rows: [admin] } = await db.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
await db.query(
  `INSERT INTO account_tokens(user_id, purpose, token_hash, expires_at)
   VALUES ($1, 'reset', $2, now() + interval '10 minutes')`, [admin.id, httpHash]);

try {
  const forgot = await fetch(`${BASE}/en/account/forgot`);
  check("la page « mot de passe oublié » répond",
        forgot.status === 200 && (await forgot.text()).includes("Forgot password"));

  const sent = await (await fetch(`${BASE}/en/account/forgot?sent=1`)).text();
  check("la confirmation ne dit pas si le compte existe",
        sent.includes("If an account matches"));

  const badToken = await (await fetch(`${BASE}/en/account/set-password?token=invalide`)).text();
  check("un jeton invalide mène au même message qu'un jeton inconnu",
        badToken.includes("no longer valid"));

  const goodToken = await (await fetch(
    `${BASE}/en/account/set-password?token=${encodeURIComponent(httpToken)}`)).text();
  check("un jeton valable affiche le formulaire, adresse comprise",
        goodToken.includes("new-password") && goodToken.includes("admin@khmerestate.kh"));

  const { rows: [notBurned] } = await db.query(
    `SELECT used_at IS NULL AS open FROM account_tokens WHERE token_hash = $1`, [httpHash]);
  check("afficher la page ne consomme pas le jeton", notBurned.open === true);

  const login = await (await fetch(`${BASE}/en/login`)).text();
  check("la page de connexion propose le lien « mot de passe oublié »",
        login.includes("/en/account/forgot"));
} finally {
  await db.query(`DELETE FROM account_tokens WHERE token_hash = $1`, [httpHash]);
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
