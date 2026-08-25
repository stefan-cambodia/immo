/**
 * Stockage des médias — couche d'abstraction, sur le modèle du transport
 * email et de la cartographie (§7, §11) : changer de fournisseur revient à
 * changer des variables d'environnement, aucun code applicatif ne dépend
 * du fournisseur.
 *
 *   MEDIA_STORAGE     local | s3                      (défaut : local)
 *   MEDIA_LOCAL_DIR   répertoire du mode local        (défaut : var/media)
 *   MEDIA_PUBLIC_URL  base publique des URL générées  (défaut : /media en local,
 *                                                      obligatoire en S3 — l'URL CDN)
 *   S3_ENDPOINT       https://s3.ap-southeast-1.amazonaws.com, MinIO, R2…
 *   S3_REGION         région de signature             (défaut : us-east-1)
 *   S3_BUCKET         nom du bucket
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *
 * Le mode `local` écrit sous `var/media/` et l'application sert ces
 * fichiers sur `/media/...` : le même chemin public que produira le CDN,
 * pour que rien d'autre ne change au basculement. Le mode `s3` signe des
 * PUT SigV4 en adressage par chemin (`endpoint/bucket/clé`), compatible
 * AWS, MinIO et R2 — sans SDK, comme les fournisseurs d'email.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

const CACHE_CONTROL = "public, max-age=31536000, immutable";

export function createMediaStore(env = process.env, { fetchImpl = fetch } = {}) {
  const kind = env.MEDIA_STORAGE || "local";
  if (kind === "local") {
    return new LocalStore(
      resolve(env.MEDIA_LOCAL_DIR || "var/media"),
      (env.MEDIA_PUBLIC_URL || "/media").replace(/\/$/, "")
    );
  }
  if (kind === "s3") {
    for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID",
                        "S3_SECRET_ACCESS_KEY", "MEDIA_PUBLIC_URL"]) {
      if (!env[name]) throw new Error(`${name} absent (MEDIA_STORAGE=s3)`);
    }
    return new S3Store({
      endpoint: env.S3_ENDPOINT.replace(/\/$/, ""),
      region: env.S3_REGION || "us-east-1",
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      publicUrl: env.MEDIA_PUBLIC_URL.replace(/\/$/, ""),
      fetchImpl,
    });
  }
  throw new Error(`MEDIA_STORAGE inconnu : ${kind} (attendu : local | s3)`);
}

/** Refuse toute clé qui sortirait du préfixe : la clé vient de nos jobs,
 *  mais un chemin est un chemin — il se vérifie. */
function assertSafeKey(key) {
  if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(key) || normalize(key).startsWith("..")) {
    throw new Error(`clé de média invalide : ${key}`);
  }
}

export class LocalStore {
  constructor(dir, publicUrl) {
    this.dir = dir; this.publicUrl = publicUrl; this.provider = "local";
  }

  // Pas de troisième paramètre : le type de contenu est ignoré en local,
  // l'extension suffit à la route qui sert ces fichiers.
  async put(key, body) {
    assertSafeKey(key);
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return `${this.publicUrl}/${key}`;
  }

  async remove(key) {
    assertSafeKey(key);
    await rm(join(this.dir, key), { force: true });
    // Les dossiers devenus vides (p/<média>/) sont élagués jusqu'à la racine
    // du magasin : un média retiré ne laisse rien, pas même un répertoire.
    let dir = dirname(join(this.dir, key));
    while (dir.startsWith(this.dir + sep) && dir !== this.dir) {
      const left = await readdir(dir).catch(() => null);
      if (left === null || left.length > 0) break;
      await rmdir(dir).catch(() => {});
      dir = dirname(dir);
    }
  }
}

export class S3Store {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey, publicUrl, fetchImpl }) {
    this.endpoint = endpoint; this.region = region; this.bucket = bucket;
    this.accessKeyId = accessKeyId; this.secretAccessKey = secretAccessKey;
    this.publicUrl = publicUrl; this.fetch = fetchImpl; this.provider = "s3";
  }

  async put(key, body, contentType) {
    assertSafeKey(key);
    const res = await this.request("PUT", key, body, {
      "content-type": contentType,
      "cache-control": CACHE_CONTROL,
    });
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} : ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return `${this.publicUrl}/${key}`;
  }

  async remove(key) {
    assertSafeKey(key);
    const res = await this.request("DELETE", key, null, {});
    // 404 : déjà absent — la suppression est idempotente.
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} : ${res.status}`);
  }

  /** Requête signée AWS Signature v4 — le strict nécessaire pour PUT/DELETE. */
  async request(method, key, body, extraHeaders) {
    const url = new URL(`${this.endpoint}/${this.bucket}/${key}`);
    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20260824T031500Z
    const date = now.slice(0, 8);
    const payloadHash = createHash("sha256").update(body ?? "").digest("hex");

    const headers = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": now,
      ...Object.fromEntries(Object.entries(extraHeaders).filter(([, v]) => v)),
    };
    const signedNames = Object.keys(headers).sort();
    // Bloc d'en-tetes canonique : chaque ligne "nom:valeur\n" ; le join
    // final ajoute la ligne vide que le format exige apres le bloc.
    const canonicalHeaders = signedNames
      .map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
    const canonical = [
      method,
      url.pathname.split("/").map(encodeURIComponent).join("/"),
      "", // pas de chaine de requete sur PUT/DELETE d'objet
      canonicalHeaders,
      signedNames.join(";"),
      payloadHash,
    ].join("\n");

    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", now, scope,
                    createHash("sha256").update(canonical).digest("hex")].join("\n");

    const hmac = (k, v) => createHmac("sha256", k).update(v).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, date),
                                      this.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");

    return this.fetch(url, {
      method,
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
      },
      body: body ?? undefined,
    });
  }
}
