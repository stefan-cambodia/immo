/**
 * Coffre des archives d'audit — chiffrement au repos et copie hors site.
 *
 * Deux protections indépendantes, chacune activée par son environnement :
 *
 *   ARCHIVE_KEY            64 hexadécimaux (AES-256) : les archives sont
 *                          chiffrées sur le disque, la version en clair
 *                          n'y survit pas.
 *   ARCHIVE_S3_BUCKET      copie hors site via la même couche S3 signée
 *                          SigV4 que les médias. Les accès reprennent
 *                          S3_ENDPOINT / S3_ACCESS_KEY_ID / … et peuvent
 *                          être surchargés par ARCHIVE_S3_* (un bucket et
 *                          des accès dédiés, plus restreints, sont la
 *                          bonne pratique).
 *
 * Le chiffrement est AES-256-GCM : l'étiquette d'authentification fait
 * qu'une archive altérée ne se déchiffre pas « presque bien » — elle ne se
 * déchiffre pas du tout. L'empreinte SHA-256 consignée dans l'entrée
 * `audit_purged` reste celle du CONTENU en clair : c'est elle qui atteste
 * ce qui a été purgé, quel que soit l'habillage sur le disque.
 *
 * Ce que ce module ne résout pas : la garde de la clé elle-même (elle vit
 * dans l'environnement) et l'exercice de restauration — voir le README.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { S3Store } from "./media-store.mjs";

/** En-tête de format : identifie une archive chiffrée par ce module, v1. */
const MAGIC = Buffer.from("KEAR1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseArchiveKey(env = process.env) {
  const raw = env.ARCHIVE_KEY;
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error("ARCHIVE_KEY invalide : 64 caractères hexadécimaux attendus (AES-256).");
  }
  return Buffer.from(raw, "hex");
}

export function encryptArchive(plaintext, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptArchive(sealed, key) {
  if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES
      || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("format d'archive chiffrée inconnu");
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // GCM : une clé fausse ou un octet altéré font échouer `final()`.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Le dépôt hors site, ou null si aucun n'est configuré. */
export function createOffsiteStore(env = process.env, { fetchImpl = fetch } = {}) {
  const bucket = env.ARCHIVE_S3_BUCKET;
  if (!bucket) return null;
  const pick = (name) => env[`ARCHIVE_${name}`] || env[name];
  for (const name of ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    if (!pick(name)) throw new Error(`${name} absent (ARCHIVE_S3_BUCKET est posé)`);
  }
  return new S3Store({
    endpoint: pick("S3_ENDPOINT").replace(/\/$/, ""),
    region: pick("S3_REGION") || "us-east-1",
    bucket,
    accessKeyId: pick("S3_ACCESS_KEY_ID"),
    secretAccessKey: pick("S3_SECRET_ACCESS_KEY"),
    // Les archives ne sont pas publiques : l'« URL » renvoyée n'est qu'un
    // identifiant s3:// consigné dans le résumé du job.
    publicUrl: `s3://${bucket}`,
    fetchImpl,
  });
}
