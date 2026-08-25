/**
 * Envoi de photos — le canal manuel du back-office (§6.1, §7).
 *
 * Partagé entre l'action de création d'un bien, la route d'envoi et le
 * contrôle `db/checks/upload.mjs`. Ce module ne connaît ni le formulaire ni
 * la session : il reçoit des octets, un bien et un auteur, et rend des
 * lignes `media` prêtes pour le job `process-media`.
 *
 * Le type d'image est reconnu à ses premiers octets (jamais à l'extension
 * ni au Content-Type annoncés) : JPEG, PNG, WebP, AVIF. Rien d'autre.
 */
import { randomUUID } from "node:crypto";

/** Au-delà, une photo d'annonce est un fichier brut d'appareil, pas une
 *  photo à publier : le job produirait 1280 px de toute façon. */
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
/** Par envoi, pas par bien : une fiche peut en recevoir davantage en
 *  plusieurs fois, mais une requête reste bornée. */
export const MAX_PHOTOS_PER_UPLOAD = 20;

const SIGNATURES = [
  { ext: "jpg",  contentType: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png",  contentType: "image/png",
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "webp", contentType: "image/webp",
    test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF"
              && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "avif", contentType: "image/avif",
    test: (b) => b.subarray(4, 8).toString("latin1") === "ftyp"
              && ["avif", "avis"].includes(b.subarray(8, 12).toString("latin1")) },
];

/** Reconnaît une image à sa signature. Renvoie { ext, contentType } ou null. */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  return SIGNATURES.find((s) => s.test(bytes)) ?? null;
}

/**
 * Valide un lot avant toute écriture. Lève une Error dont `message` est un
 * code stable (`no_files`, `too_many`, `too_large`, `unsupported_type`) :
 * les formulaires le traduisent, le contrôle le compare.
 * Renvoie [{ bytes, ext, contentType }].
 */
export function validatePhotos(buffers) {
  if (buffers.length === 0) throw new Error("no_files");
  if (buffers.length > MAX_PHOTOS_PER_UPLOAD) throw new Error("too_many");
  return buffers.map((bytes) => {
    if (bytes.length > MAX_PHOTO_BYTES) throw new Error("too_large");
    const kind = sniffImage(bytes);
    if (!kind) throw new Error("unsupported_type");
    return { bytes, ...kind };
  });
}

/**
 * Dépose un lot validé sur le stockage puis l'enregistre pour un bien, dans
 * la transaction fournie. Les fichiers sont écrits AVANT les lignes : si
 * l'insertion échoue, ce qui a été déposé est retiré — un fichier orphelin
 * sur le stockage n'est visible de personne, une ligne sans fichier est
 * une image cassée sur la fiche.
 *
 * Renvoie [{ id, url, position, bytes, contentType }].
 */
export async function storePhotos(client, store, { propertyId, photos, userId }) {
  const { rows: [{ next }] } = await client.query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM media WHERE property_id = $1`,
    [propertyId]);

  const stored = [];
  try {
    for (const [i, photo] of photos.entries()) {
      const id = randomUUID();
      const key = `p/${id}/source.${photo.ext}`;
      const url = await store.put(key, photo.bytes, photo.contentType);
      stored.push({ id, key, url, position: Number(next) + i,
                    bytes: photo.bytes.length, contentType: photo.contentType });
    }
    for (const s of stored) {
      await client.query(
        `INSERT INTO media(id, property_id, url, position, uploaded_by, content_type, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.id, propertyId, s.url, s.position, userId, s.contentType, s.bytes]);
    }
  } catch (err) {
    await Promise.all(stored.map((s) => store.remove(s.key).catch(() => {})));
    throw err;
  }
  return stored.map(({ id, url, position, bytes, contentType }) =>
    ({ id, url, position, bytes, contentType }));
}

/** Les clés de stockage d'un média : sa source et ses variantes, pour
 *  autant qu'elles vivent sur notre stockage (une URL Telegram n'est pas
 *  à nous, on ne la « retire » pas). */
export function storageKeys(media, store) {
  const prefix = `${store.publicUrl}/`;
  const urls = [media.url, ...(media.variants ?? []).map((v) => v.url)];
  return urls.filter((u) => typeof u === "string" && u.startsWith(prefix))
             .map((u) => u.slice(prefix.length));
}

/**
 * Retire une photo : la ligne d'abord (la fiche cesse de la référencer),
 * les fichiers ensuite. Un fichier qui résiste ne fait pas échouer le
 * retrait — il n'est plus référencé, c'est ce qui compte ; il sera repris
 * par un nettoyage de stockage, pas par un utilisateur qui réessaie.
 * Renvoie la ligne retirée (avec la référence du bien) ou null.
 */
export async function removePhoto(client, store, mediaId) {
  const { rows: [media] } = await client.query(
    `DELETE FROM media m USING properties p
     WHERE m.id = $1 AND p.id = m.property_id
     RETURNING m.id, m.url, m.variants, m.position, m.property_id AS "propertyId",
               p.reference`, [mediaId]);
  if (!media) return null;
  for (const key of storageKeys(media, store)) {
    await store.remove(key).catch(() => {});
  }
  return media;
}

/**
 * Peut-on gérer les photos de ce bien ? La modération, toujours ; une
 * agence, si elle y a une annonce — c'est la même règle que pour créer un
 * bien sous son nom, appliquée à un bien existant.
 */
export async function canManageProperty(client, user, propertyId) {
  if (user.role === "admin") return true;
  if (!user.agencyId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM listings WHERE property_id = $1 AND agency_id = $2 LIMIT 1`,
    [propertyId, user.agencyId]);
  return rows.length > 0;
}

/** Les envois récents d'un périmètre (null = tout), pour le back-office. */
export async function listRecentUploads(client, { agencyId, limit }) {
  const { rows } = await client.query(
    `SELECT m.id, m.url, m.position, m.byte_size AS bytes, m.processed_at AS "processedAt",
            m.process_error AS "processError", m.created_at AS "createdAt",
            (SELECT v->>'url' FROM jsonb_array_elements(m.variants) v
              WHERE v->>'format' = 'jpeg' LIMIT 1) AS thumb,
            p.reference, u.name AS "uploadedBy"
     FROM media m
     JOIN properties p ON p.id = m.property_id
     LEFT JOIN users u ON u.id = m.uploaded_by
     WHERE m.uploaded_by IS NOT NULL
       AND ($1::uuid IS NULL OR EXISTS (
             SELECT 1 FROM listings l WHERE l.property_id = p.id AND l.agency_id = $1::uuid))
     ORDER BY m.created_at DESC LIMIT $2`, [agencyId ?? null, limit]);
  return rows;
}
