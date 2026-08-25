#!/usr/bin/env node
/**
 * Vérifie l'envoi de photos depuis le back-office (§6.1, §7).
 *
 * Ce qui compte : le type est reconnu aux octets et rien d'autre ne passe
 * (un SVG est un script), les bornes de taille et de nombre tiennent, un
 * envoi dépose la source sur NOTRE stockage avant d'écrire la ligne — et
 * nettoie ce qu'il a déposé si la ligne échoue —, la route HTTP exige une
 * session et le périmètre de l'agence, et le job `process-media` reprend
 * une photo envoyée exactement comme une photo venue du bot.
 *
 * La partie stockage tourne sur un répertoire temporaire et une transaction
 * annulée. La partie HTTP est réelle (session, fichiers sous var/media,
 * ligne media) et se nettoie ; les entrées d'audit restent — le journal est
 * en ajout seul, c'est le comportement vérifié.
 *
 *   node db/checks/upload.mjs [--base http://localhost:3111]
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import sharp from "sharp";
import { createMediaStore, LocalStore } from "../lib/media-store.mjs";
import { canManageProperty, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_UPLOAD, removePhoto,
         sniffImage, storageKeys, storePhotos, validatePhotos } from "../lib/media-upload.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("base", "http://localhost:3111");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const image = (format, w = 800, h = 600) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 60, b: 30 } } })
    [format]().toBuffer();
const jpeg = await image("jpeg");

// ------------------------------------------------------------- Signatures
console.log("Reconnaissance du type");
check("JPEG reconnu", sniffImage(jpeg)?.contentType === "image/jpeg");
check("PNG reconnu", sniffImage(await image("png"))?.ext === "png");
check("WebP reconnu", sniffImage(await image("webp"))?.ext === "webp");
check("AVIF reconnu", sniffImage(await image("avif"))?.ext === "avif");
check("un SVG est refusé, quel que soit son nom",
      sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')) === null);
check("un fichier vide ou tronqué est refusé", sniffImage(Buffer.alloc(0)) === null
      && sniffImage(jpeg.subarray(0, 4)) === null);

const code = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
check("aucun fichier → no_files", code(() => validatePhotos([])) === "no_files");
check(`plus de ${MAX_PHOTOS_PER_UPLOAD} → too_many`,
      code(() => validatePhotos(Array(MAX_PHOTOS_PER_UPLOAD + 1).fill(jpeg))) === "too_many");
const huge = Buffer.concat([jpeg, Buffer.alloc(MAX_PHOTO_BYTES)]);
check("au-delà de la taille → too_large", code(() => validatePhotos([huge])) === "too_large");
check("type inconnu → unsupported_type",
      code(() => validatePhotos([Buffer.from("pas une image du tout, vraiment")])) === "unsupported_type");
check("un lot valide rend type et extension",
      validatePhotos([jpeg])[0].ext === "jpg");

// --------------------------------------------------------------- Stockage
console.log("Stockage (répertoire temporaire, transaction annulée)");
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo" });
await db.connect();

// Un bien dont AUCUN média n'attend le job : le passage du job plus bas ne
// traitera que notre photo, pas un arriéré du seed.
const { rows: [property] } = await db.query(
  `SELECT p.id, p.reference, l.agency_id AS "agencyId"
   FROM properties p JOIN listings l ON l.property_id = p.id
   WHERE l.status = 'active'
   ORDER BY (SELECT count(*) FROM media m WHERE m.property_id = p.id AND m.processed_at IS NULL),
            p.reference LIMIT 1`);
const tmp = await mkdtemp(join(tmpdir(), "chk-upload-"));
const tmpStore = new LocalStore(tmp, "/media");

try {
  await db.query("BEGIN");
  const { rows: [{ max }] } = await db.query(
    `SELECT COALESCE(MAX(position), -1) AS max FROM media WHERE property_id = $1`, [property.id]);
  const photos = validatePhotos([jpeg, await image("png", 400, 300)]);
  const stored = await storePhotos(db, tmpStore, { propertyId: property.id, photos, userId: null });
  check("deux photos déposées, positions à la suite des existantes",
        stored.length === 2 && stored[0].position === Number(max) + 1
          && stored[1].position === Number(max) + 2, JSON.stringify(stored));
  check("l'URL est celle de notre stockage, source par extension reconnue",
        stored[0].url === `/media/p/${stored[0].id}/source.jpg`
          && stored[1].url.endsWith("/source.png"), stored[0].url);
  const onDisk = await stat(join(tmp, "p", stored[0].id, "source.jpg")).then((s) => s.size, () => -1);
  check("le fichier est sur le disque, intégral", onDisk === jpeg.length, String(onDisk));
  const { rows: mediaRows } = await db.query(
    `SELECT content_type AS ct, byte_size AS bytes, processed_at AS done FROM media WHERE id = $1`,
    [stored[0].id]);
  check("la ligne media porte type, taille, et attend le job",
        mediaRows[0]?.ct === "image/jpeg" && mediaRows[0].bytes === jpeg.length && mediaRows[0].done === null);

  const removed = await removePhoto(db, tmpStore, stored[0].id);
  const gone = await stat(join(tmp, "p", stored[0].id, "source.jpg")).then(() => false, () => true);
  check("le retrait supprime la ligne puis le fichier",
        removed?.reference === property.reference && gone);
  check("les clés de stockage ignorent les URL qui ne sont pas à nous",
        storageKeys({ url: "https://api.telegram.org/file/x.jpg",
                      variants: [{ url: "/media/p/a/320.avif" }] }, tmpStore).join() === "p/a/320.avif");

  // Insertion impossible (bien inexistant) : les fichiers déposés repartent.
  const before = (await readdir(join(tmp, "p"))).length;
  await db.query("SAVEPOINT orphan");
  const failed = await storePhotos(db, tmpStore,
    { propertyId: randomUUID(), photos: validatePhotos([jpeg]), userId: null }).then(() => false, () => true);
  await db.query("ROLLBACK TO SAVEPOINT orphan");
  const after = (await readdir(join(tmp, "p"))).length;
  check("une insertion refusée retire ce qui venait d'être déposé", failed && after === before,
        `${before} → ${after}`);

  const { rows: [admin] } = await db.query(`SELECT id, role, agency_id AS "agencyId" FROM users WHERE role = 'admin' LIMIT 1`);
  const { rows: [other] } = await db.query(
    `SELECT id, role, agency_id AS "agencyId" FROM users
     WHERE role = 'agency' AND agency_id <> $1 LIMIT 1`, [property.agencyId]);
  const { rows: [owner] } = await db.query(
    `SELECT id, role, agency_id AS "agencyId" FROM users WHERE role = 'agency' AND agency_id = $1 LIMIT 1`,
    [property.agencyId]);
  check("la modération gère tout bien", await canManageProperty(db, admin, property.id));
  check("une agence gère un bien où elle a une annonce",
        owner ? await canManageProperty(db, owner, property.id) : true);
  check("une autre agence ne le gère pas",
        other ? !(await canManageProperty(db, other, property.id)) : true);
} finally {
  await db.query("ROLLBACK");
  await rm(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------- HTTP
console.log("Route d'envoi (session réelle, nettoyée)");
const { rows: [admin] } = await db.query(`SELECT id FROM users WHERE role = 'admin' AND active LIMIT 1`);
const { rows: [stranger] } = await db.query(
  `SELECT id FROM users WHERE role = 'agency' AND active AND agency_id <> $1 LIMIT 1`, [property.agencyId]);
const session = async (userId) => {
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
                 [createHash("sha256").update(token).digest("hex"), userId]);
  return { token, hash: createHash("sha256").update(token).digest("hex") };
};
const adminSession = await session(admin.id);
const strangerSession = stranger ? await session(stranger.id) : null;

const post = async (fields, cookie) => {
  const fd = new FormData();
  fd.append("locale", "en");
  for (const [k, v] of fields) {
    if (v instanceof Blob) fd.append(k, v, v.type === "image/jpeg" ? "photo.jpg" : "file.bin");
    else fd.append(k, v);
  }
  const res = await fetch(`${BASE}/api/backoffice/photos`, {
    method: "POST", body: fd, redirect: "manual",
    headers: cookie ? { cookie: `bo_session=${cookie}` } : {} });
  return { status: res.status, location: res.headers.get("location") ?? "" };
};
const asJpeg = (buf) => new Blob([buf], { type: "image/jpeg" });

const anon = await post([["reference", property.reference], ["photos", asJpeg(jpeg)]]);
check("sans session : renvoi vers la connexion, rien n'est écrit",
      anon.status === 303 && anon.location.includes("/en/login"), `${anon.status} ${anon.location}`);
const unknown = await post([["reference", "ZZ-INCONNU"], ["photos", asJpeg(jpeg)]], adminSession.token);
check("référence inconnue → error=unknown_reference",
      unknown.location.includes("error=unknown_reference"), unknown.location);
const svg = await post([["reference", property.reference],
  ["photos", new Blob(["<svg/>"], { type: "image/svg+xml" })]], adminSession.token);
check("un SVG annoncé comme image est refusé aux octets",
      svg.location.includes("error=unsupported_type"), svg.location);
const empty = await post([["reference", property.reference]], adminSession.token);
check("aucun fichier → error=no_files", empty.location.includes("error=no_files"), empty.location);
if (strangerSession) {
  const forbidden = await post([["reference", property.reference], ["photos", asJpeg(jpeg)]],
                               strangerSession.token);
  check("une agence tierce est refusée (forbidden)",
        forbidden.location.includes("error=forbidden"), forbidden.location);
}

const marker = await image("jpeg", 1400, 900);
const ok = await post([["reference", property.reference.toLowerCase()], ["photos", asJpeg(marker)]],
                      adminSession.token);
check("un envoi valide → 303 ?uploaded=1 (référence normalisée)",
      ok.status === 303 && ok.location.includes("uploaded=1"), `${ok.status} ${ok.location}`);
const { rows: [media] } = await db.query(
  `SELECT id, url, byte_size AS bytes FROM media
   WHERE property_id = $1 AND uploaded_by = $2 ORDER BY created_at DESC LIMIT 1`, [property.id, admin.id]);
check("la ligne media est attribuée à l'auteur, taille exacte",
      media && media.bytes === marker.length, JSON.stringify(media));

const realStore = createMediaStore();
try {
  const served = await fetch(`${BASE}${media.url}`);
  check("la source est servie sur /media/ avec son type",
        served.status === 200 && served.headers.get("content-type") === "image/jpeg", String(served.status));

  const { stdout } = await exec("node",
    ["db/jobs/process-media.mjs", "--property", property.id, "--json"],
    { env: { ...process.env, NEXT_PUBLIC_SITE_URL: BASE } });
  const summary = JSON.parse(stdout.trim().split("\n").pop());
  const { rows: [done] } = await db.query(
    `SELECT processed_at AS at, process_error AS err, width, jsonb_array_length(variants) AS n
     FROM media WHERE id = $1`, [media.id]);
  check("le job traite la photo envoyée comme toute autre source",
        summary.processed >= 1 && done.at && !done.err && done.width === 1400 && Number(done.n) >= 3,
        JSON.stringify({ summary, done }));

  const page = await (await fetch(`${BASE}/en/backoffice`,
    { headers: { cookie: `bo_session=${adminSession.token}` } })).text();
  check("le back-office liste l'envoi avec son état et le bouton de retrait",
        page.includes(media.id) && page.includes("Variants ready"));

  const { rows: audits } = await db.query(
    `SELECT details FROM audit_log WHERE action = 'media_uploaded' AND details->'mediaIds' ? $1`, [media.id]);
  check("l'envoi est journalisé avec ses identifiants", audits.length === 1);
} finally {
  // Nettoyage réel : ligne et fichiers (source + variantes), sessions.
  const removed = await removePhoto(db, realStore, media.id);
  const dirGone = await readdir(join(realStore.dir, "p", media.id)).then((f) => f.length === 0, () => true);
  check("le retrait réel ne laisse ni ligne ni fichier", removed !== null && dirGone);
  await rm(join(realStore.dir, "p", media.id), { recursive: true, force: true });
  await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`,
                 [[adminSession.hash, strangerSession?.hash].filter(Boolean)]);
}

await db.end();
console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail === 0 ? 0 : 1);
