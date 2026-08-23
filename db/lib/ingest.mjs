import { findDuplicates } from "./dedup.mjs";

/**
 * Entonnoir commun aux canaux d'ingestion (§6.1).
 *
 * Bot Telegram, flux XML/CSV et back-office déposent tous une soumission ici.
 * Le fait qu'aucun ne puisse court-circuiter cette fonction est ce qui garantit
 * qu'aucun ne peut contourner la règle du pin manuel.
 *
 * Une nuance qui n'apparaît qu'une fois la déduplication en place : un pin
 * n'est exigé que pour créer un *nouveau* bien. Une annonce rattachée à un
 * bien existant hérite du pin déjà posé — c'est précisément ce que la
 * déduplication fait gagner aux agences, et ce qui rend le canal Telegram
 * supportable pour un agent sur son téléphone.
 */

/**
 * @param {import("pg").PoolClient | import("pg").Client} db  client déjà dans
 *        une transaction ouverte par l'appelant : c'est lui qui décide de la
 *        portée transactionnelle, le job comme l'application.
 */
export async function ingest(db, input) {
  const { normalized: n } = input;

  // Idempotence : le même identifiant d'agence n'entre qu'une fois. Un flux
  // XML nocturne rejoué ne doit rien dupliquer.
  if (input.externalRef) {
    const { rows: prior } = await db.query(
      `SELECT id, status::text FROM submissions
       WHERE agency_id = $1 AND source = $2::listing_source AND external_ref = $3`,
      [input.agencyId, input.source, input.externalRef]
    );
    if (prior.length) return { status: "duplicate_submission", submissionId: prior[0].id };
  }

  const phashes = (input.photos ?? []).map((p) => p.phash).filter(Boolean);

  const verdict = await findDuplicates(db, {
    buildingId: n.buildingId ?? null,
    locationId: n.locationId,
    propertyType: n.propertyType,
    floor: n.floor ?? null,
    bedrooms: n.bedrooms ?? 0,
    indoorAreaSqm: n.indoorAreaSqm ?? null,
    landAreaSqm: n.landAreaSqm ?? null,
    phashes,
    agencyId: input.agencyId,
  });

  const hasPin = Number.isFinite(n.lng) && Number.isFinite(n.lat);
  // Le pin ne bloque que la création d'un bien. Une fusion se greffe sur un
  // bien déjà pointé.
  const needsPin = verdict.decision !== "merge" && !hasPin;

  {
    const client = db;
    const { rows: sub } = await client.query(
      `INSERT INTO submissions(source, external_ref, agency_id, agent_id, payload,
                               normalized, status, decision, score, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [input.source, input.externalRef ?? null, input.agencyId, input.agentId,
       JSON.stringify(input.payload), JSON.stringify(n),
       needsPin ? "needs_pin" : "accepted",
       verdict.decision, verdict.score, verdict.reasons]
    );
    const submissionId = sub[0].id;

    if (needsPin) {
      return { status: "needs_pin", submissionId, decision: verdict.decision,
               score: verdict.score, reasons: verdict.reasons };
    }

    let propertyId;
    let reference;

    if (verdict.decision === "merge" && verdict.propertyId) {
      propertyId = verdict.propertyId;
      const { rows } = await client.query(
        `SELECT reference FROM properties WHERE id = $1`, [propertyId]);
      reference = rows[0].reference;
    } else {
      const created = await createProperty(client, input, n);
      propertyId = created.id;
      reference = created.reference;

      // Correspondance partielle : le bien est créé, et la paire part en file
      // de validation. Jamais de fusion automatique sur un cas ambigu (§6.2).
      if (verdict.decision === "review" && verdict.propertyId) {
        const [a, b] = propertyId < verdict.propertyId
          ? [propertyId, verdict.propertyId] : [verdict.propertyId, propertyId];
        await client.query(
          `INSERT INTO dedup_candidates(property_a_id, property_b_id, score, reasons)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [a, b, verdict.score, verdict.reasons]);
      }
    }

    const listingId = await createListing(client, input, n, propertyId);
    await attachPhotos(client, input, propertyId);

    await client.query(
      `UPDATE submissions SET property_id = $2, listing_id = $3 WHERE id = $1`,
      [submissionId, propertyId, listingId]);

    return { status: "accepted", decision: verdict.decision, submissionId,
             propertyId, listingId, reference,
             score: verdict.score, reasons: verdict.reasons };
  }
}

async function createProperty(client, input, n) {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const reference = `IN-${suffix}${Date.now() % 1000}`;

  // Traçabilité du pin. Les coordonnées viennent d'un humain — l'agent sur son
  // téléphone, ou le CRM de l'agence où quelqu'un les a posées. Jamais d'une
  // adresse texte géocodée (principe n°2) : un flux qui n'apporte qu'une
  // adresse repart en `needs_pin`.
  const pinBy = `${input.source}:${input.externalRef ?? "sans-référence"}`;

  const { rows } = await client.query(
    `INSERT INTO properties(reference, building_id, property_type, location_id, geo_point,
       geo_pin_by, geo_pin_at, floor, unit_number, bedrooms, bathrooms,
       indoor_area_sqm, land_area_sqm, title_type, year_built, furnished, amenities)
     VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326), $7, now(),
             $8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, reference`,
    [reference, n.buildingId ?? null, n.propertyType, n.locationId, n.lng, n.lat,
     pinBy, n.floor ?? null, n.unitNumber ?? null, n.bedrooms ?? 0, n.bathrooms ?? 0,
     n.indoorAreaSqm ?? null, n.landAreaSqm ?? null, n.titleType ?? "unknown",
     n.yearBuilt ?? null, n.furnished ?? false, n.amenities ?? []]
  );
  return rows[0];
}

async function createListing(client, input, n, propertyId) {
  const lang = n.descriptionLang ?? "en";
  // La traduction automatique à l'ingestion (§4.1) n'est pas branchée : la
  // description reste dans sa langue source, non marquée comme traduite. Les
  // champs structurés, eux, sont déjà traduits par les tables de référence.
  const description = n.description ? { [lang]: n.description } : {};

  const { rows } = await client.query(
    `INSERT INTO listings(property_id, agency_id, agent_id, transaction_type, price_usd,
       price_period, negotiable, status, source, description_i18n,
       description_source_lang, machine_translated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,false)
     ON CONFLICT (property_id, agency_id, transaction_type)
       WHERE status = 'active'
     DO UPDATE SET price_usd = EXCLUDED.price_usd,
                   last_confirmed_at = now(),
                   expires_at = now() + interval '45 days',
                   updated_at = now()
     RETURNING id`,
    [propertyId, input.agencyId, input.agentId, n.transactionType, n.priceUsd,
     n.transactionType === "rent" ? "monthly" : "total", n.negotiable ?? true,
     input.source, JSON.stringify(description), lang]
  );
  return rows[0].id;
}

async function attachPhotos(client, input, propertyId) {
  const photos = input.photos ?? [];
  for (const [position, photo] of photos.entries()) {
    await client.query(
      `INSERT INTO media(property_id, url, position, width, height, phash)
       VALUES ($1,$2,$3,$4,$5,$6::bit(64))`,
      [propertyId, photo.url, position, photo.width ?? null, photo.height ?? null, photo.phash]
    );
  }
}

/**
 * Achève une soumission restée en attente de pin.
 *
 * Le pin arrive toujours d'un humain — l'agent qui répond au bot, ou un
 * modérateur qui le pose depuis le back-office. La déduplication est rejouée à
 * ce moment-là : entre le dépôt et la pose du pin, un autre canal a pu créer
 * le bien, et la soumission doit alors se greffer dessus plutôt que d'en
 * fabriquer un doublon.
 *
 * @param {import("pg").PoolClient | import("pg").Client} db
 */
export async function completeSubmission(db, submissionId, pin, actor) {
  const { rows } = await db.query(
    `SELECT id, source, agency_id, agent_id, external_ref, normalized, status::text
     FROM submissions WHERE id = $1 FOR UPDATE`,
    [submissionId]);
  if (!rows.length) return { status: "failed", error: "soumission inconnue" };

  const sub = rows[0];
  if (sub.status !== "needs_pin") {
    return { status: "failed", submissionId, error: `état inattendu : ${sub.status}` };
  }
  if (!Number.isFinite(pin.lng) || !Number.isFinite(pin.lat)) {
    return { status: "failed", submissionId, error: "pin absent" };
  }

  const n = { ...sub.normalized, lng: pin.lng, lat: pin.lat };

  const verdict = await findDuplicates(db, {
    buildingId: n.buildingId ?? null,
    locationId: n.locationId,
    propertyType: n.propertyType,
    floor: n.floor ?? null,
    bedrooms: n.bedrooms ?? 0,
    indoorAreaSqm: n.indoorAreaSqm ?? null,
    landAreaSqm: n.landAreaSqm ?? null,
    phashes: [],
    agencyId: sub.agency_id,
  });

  const input = {
    source: sub.source, agencyId: sub.agency_id, agentId: sub.agent_id,
    externalRef: sub.external_ref, payload: {}, normalized: n, photos: [],
  };

  let propertyId, reference;
  if (verdict.decision === "merge" && verdict.propertyId) {
    propertyId = verdict.propertyId;
    const { rows: p } = await db.query(
      `SELECT reference FROM properties WHERE id = $1`, [propertyId]);
    reference = p[0].reference;
  } else {
    // Le pin posé à la main est tracé avec son auteur : c'est l'étape
    // bloquante du processus, sa provenance doit rester vérifiable.
    const created = await createProperty(db, { ...input, source: actor ?? sub.source }, n);
    propertyId = created.id;
    reference = created.reference;

    if (verdict.decision === "review" && verdict.propertyId) {
      const [a, b] = propertyId < verdict.propertyId
        ? [propertyId, verdict.propertyId] : [verdict.propertyId, propertyId];
      await db.query(
        `INSERT INTO dedup_candidates(property_a_id, property_b_id, score, reasons)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [a, b, verdict.score, verdict.reasons]);
    }
  }

  const listingId = await createListing(db, input, n, propertyId);

  await db.query(
    `UPDATE submissions
     SET status = 'accepted', decision = $2, score = $3, reasons = $4,
         property_id = $5, listing_id = $6, normalized = $7
     WHERE id = $1`,
    [submissionId, verdict.decision, verdict.score, verdict.reasons,
     propertyId, listingId, JSON.stringify(n)]);

  return { status: "accepted", submissionId, decision: verdict.decision,
           propertyId, listingId, reference, score: verdict.score, reasons: verdict.reasons };
}
