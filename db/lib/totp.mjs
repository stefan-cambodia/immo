/**
 * TOTP (RFC 6238) — second facteur des comptes du back-office.
 *
 * Implémentation standard et sans dépendance, comme SigV4 pour S3 : HMAC-SHA1,
 * 6 chiffres, période de 30 secondes — ce que produisent Google Authenticator,
 * Aegis, FreeOTP et les gestionnaires de mots de passe.
 *
 * Deux règles de vérification :
 * - fenêtre de ±1 période, pour absorber la dérive d'horloge d'un téléphone ;
 * - un code ne sert qu'UNE fois : l'appelant conserve le dernier pas accepté
 *   (`totp_last_step`) et tout code d'un pas antérieur ou égal est refusé.
 *   Sans cela, un code intercepté resterait valable trente secondes.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secret de 20 octets (160 bits), la taille de référence pour HMAC-SHA1. */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

function hotp(secretBase32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS);
  return String(code).padStart(TOTP_DIGITS, "0");
}

export function totpAt(secretBase32, epochSeconds) {
  return hotp(secretBase32, Math.floor(epochSeconds / TOTP_PERIOD));
}

/**
 * Vérifie un code dans la fenêtre ±1, en refusant tout pas déjà servi.
 * Renvoie le pas accepté (à conserver comme `totp_last_step`), ou null.
 */
export function verifyTotp(secretBase32, code, { lastStep = 0, now = Date.now() } = {}) {
  const clean = String(code).replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = currentStep + offset;
    if (step <= lastStep) continue; // rejeu : ce pas a déjà servi
    const expected = hotp(secretBase32, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}

/** URI d'enrôlement `otpauth://` — saisie manuelle ou générateur de QR. */
export function otpauthUri(email, secretBase32, issuer = "Khmer Estate") {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1` +
    `&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}
