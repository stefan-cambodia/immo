#!/usr/bin/env node
/**
 * Vérifie le second facteur TOTP.
 *
 * Ce qui compte : l'implémentation suit la RFC 6238 (vecteurs de test
 * officiels), un code ne sert qu'une fois, la fenêtre absorbe la dérive
 * d'horloge sans plus, l'étape de connexion est un jeton de 5 minutes qui
 * ne se consomme qu'au code juste, et la désactivation d'un compte ferme
 * aussi cette étape.
 *
 * Tout tourne dans une transaction annulée à la fin ; la partie HTTP se
 * limite à la page de connexion (l'étape du code est rendue côté serveur).
 *
 *   node db/checks/totp.mjs [--base http://localhost:3111]
 */
import pg from "pg";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri,
         totpAt, verifyTotp } from "../lib/totp.mjs";
import { completeSecondFactor, issueToken, pendingSecondFactor,
         setAccountActive } from "../lib/accounts.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

// ------------------------------------------------------------ RFC 6238
console.log("RFC 6238");
// Vecteurs officiels (annexe B), secret ASCII « 12345678901234567890 »,
// codes à 8 chiffres tronqués ici aux 6 derniers — même dynamique interne.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const vectors = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
  [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
];
check("les six vecteurs officiels passent",
      vectors.every(([t, code]) => totpAt(RFC_SECRET, t) === code),
      JSON.stringify(vectors.map(([t]) => totpAt(RFC_SECRET, t))));

const secret = generateTotpSecret();
check("le secret généré fait 160 bits en base32",
      secret.length === 32 && base32Decode(secret).length === 20);
check("base32 aller-retour", base32Encode(base32Decode(secret)) === secret);
check("l'URI d'enrôlement porte le compte et l'émetteur",
      otpauthUri("chk@khmerestate.kh", secret)
        .startsWith("otpauth://totp/Khmer%20Estate%3Achk%40khmerestate.kh?secret=" + secret));

// ------------------------------------------------------ Fenêtre et rejeu
console.log("Fenêtre et rejeu");
const now = 1_700_000_000_000; // instant figé
const step = Math.floor(now / 1000 / 30);
const code = totpAt(secret, now / 1000);
check("un code courant est accepté et renvoie son pas",
      verifyTotp(secret, code, { now }) === step);
check("le même pas, rejoué, est refusé",
      verifyTotp(secret, code, { now, lastStep: step }) === null);
check("le code du pas précédent passe (dérive d'horloge)",
      verifyTotp(secret, totpAt(secret, now / 1000 - 30), { now }) === step - 1);
check("un code vieux de deux pas est refusé",
      verifyTotp(secret, totpAt(secret, now / 1000 - 90), { now }) === null);
check("un format invalide est refusé sans calcul",
      verifyTotp(secret, "12345", { now }) === null
        && verifyTotp(secret, "abcdef", { now }) === null);
check("les espaces de saisie sont tolérés",
      verifyTotp(secret, code.slice(0, 3) + " " + code.slice(3), { now }) === step);

// ------------------------------------------------- Étape de connexion
console.log("Étape de connexion");
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();
await db.query("BEGIN");

const { rows: [admin] } = await db.query(
  `UPDATE users SET totp_secret = $1, totp_enabled_at = now(), totp_last_step = 0
   WHERE role = 'admin' RETURNING id, email`, [secret]);

const issued = await issueToken(db, { userId: admin.id, purpose: "second_factor" });
check("l'étape s'ouvre pour 5 minutes",
      Boolean(issued?.token)
        && new Date(issued.expiresAt).getTime() - Date.now() < 6 * 60_000);

const pending = await pendingSecondFactor(db, issued.token);
check("l'étape porte le secret et le dernier pas servi",
      pending?.userId === admin.id && pending?.secret === secret
        && Number(pending?.lastStep) === 0 && pending?.role === "admin");
check("regarder l'étape ne la consomme pas",
      (await pendingSecondFactor(db, issued.token)) !== null);
check("un jeton inconnu ne montre rien",
      (await pendingSecondFactor(db, "pas-un-jeton")) === null);

const liveStep = Math.floor(Date.now() / 1000 / 30);
const done = await completeSecondFactor(db, issued.token, liveStep);
check("le code juste consomme l'étape", done?.userId === admin.id);
check("l'étape consommée ne ressert pas",
      (await pendingSecondFactor(db, issued.token)) === null
        && (await completeSecondFactor(db, issued.token, liveStep + 1)) === null);
const { rows: [afterStep] } = await db.query(
  `SELECT totp_last_step AS s FROM users WHERE id = $1`, [admin.id]);
check("le dernier pas servi est retenu sur le compte", Number(afterStep.s) === liveStep);

const second = await issueToken(db, { userId: admin.id, purpose: "second_factor" });
await setAccountActive(db, admin.id, false);
check("la désactivation du compte ferme l'étape en cours",
      (await pendingSecondFactor(db, second.token)) === null);

await db.query("ROLLBACK");

// --------------------------------------------------------- Page publique
console.log("\nPage publique");
const totpPage = await (await fetch(`${BASE}/en/login?step=totp`)).text();
check("l'étape du code est rendue sans révéler le formulaire de mot de passe",
      totpPage.includes("one-time-code") && !totpPage.includes("current-password"));
const loginPage = await (await fetch(`${BASE}/en/login`)).text();
check("la connexion normale reste inchangée",
      loginPage.includes("current-password") && !loginPage.includes("one-time-code"));

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
