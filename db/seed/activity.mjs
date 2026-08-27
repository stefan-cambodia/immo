/**
 * Activité de démonstration posée SUR les biens déjà en base : audience,
 * contacts, compteurs de localité, file de déduplication et dossiers de
 * vérification de titre.
 *
 * Pourquoi un module séparé du seed : ces sections ne fabriquent pas de biens,
 * elles en supposent. Elles doivent donc pouvoir tourner aussi bien à la fin
 * du seed de démonstration qu'APRÈS un import de vraies annonces
 * (db/jobs/import-portal.mjs) — sinon le tableau de bord agence, le badge de
 * titre et la file de modération n'auraient rien à montrer sur un jeu de
 * données réel.
 *
 *   node db/seed/activity.mjs        # rejoue l'activité sur les biens présents
 */

/**
 * @param {import("pg").Client} db
 * @param {{rnd: () => number, pick: (a: any[]) => any, int: (a: number, b: number) => number,
 *          now: number}} r  tirage aléatoire de l'appelant : le seed passe son
 *        générateur déterministe, pour qu'un seed rejoué donne la même base.
 */
export async function seedActivity(db, r) {
  const { rnd, pick, int, now } = r;

  // Idempotence : ces quatre tables appartiennent entièrement à ce module.
  // Les vider d'abord permet de rejouer l'activité sur un jeu de biens qui a
  // changé, sans repartir d'une base vide.
  await db.query(`TRUNCATE property_views, leads, title_verifications,
    verification_partners RESTART IDENTITY CASCADE`);

  // ------------------------------------------------------ Audience et contacts
  // Le tableau de bord agence n'a de sens qu'avec du trafic à montrer. La
  // distribution imite ce qu'on observe : quelques fiches captent l'essentiel
  // des vues, et le contact reste rare — un ordre de grandeur de 2 à 6 %.
  const { rows: viewable } = await db.query(
    `SELECT p.id, p.reference,
            (SELECT count(*) FROM listings l WHERE l.property_id = p.id AND l.status='active')::int AS n
     FROM properties p WHERE EXISTS (
       SELECT 1 FROM listings l WHERE l.property_id = p.id AND l.status='active')`);

  let viewCount = 0, leadCount = 0;
  for (const prop of viewable) {
    // Loi très inégale : la plupart des fiches font peu de vues, quelques-unes
    // beaucoup. Un tirage exponentiel approché suffit à le rendre.
    const base = Math.round(Math.exp(rnd() * 4.2)) + int(0, 5);
    const views = Math.min(400, base * (1 + prop.n * 0.25));

    for (let v = 0; v < views; v++) {
      const daysAgo = int(0, 59);
      const at = new Date(now - daysAgo * 86400000 - int(0, 23) * 3600000 - int(0, 59) * 60000);
      await db.query(
        `INSERT INTO property_views(property_id, session_id, locale, referrer_host, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [prop.id, `s${int(1, 40000)}`,
         pick(["en", "en", "en", "km", "zh", "fr"]),
         pick(["www.google.com", "www.google.com", "www.google.com.kh", "www.facebook.com",
               "t.me", null, null, "www.baidu.com"]),
         at]);
      viewCount++;
    }

    // Contacts : une fraction des vues, sur les annonces actives du bien.
    const { rows: offers } = await db.query(
      `SELECT id, agency_id, agent_id FROM listings
       WHERE property_id = $1 AND status = 'active'`, [prop.id]);
    const leads = Math.floor(views * (0.02 + rnd() * 0.04));
    for (let k = 0; k < leads && offers.length; k++) {
      const offer = pick(offers);
      const daysAgo = int(0, 59);
      await db.query(
        `INSERT INTO leads(listing_id, property_id, agency_id, agent_id, channel,
                           action_type, locale, session_id, referrer, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [offer.id, prop.id, offer.agency_id, offer.agent_id,
         pick(["phone", "phone", "phone", "telegram", "wechat", "form"]),
         pick(["reveal_phone", "reveal_phone", "call", "message"]),
         pick(["en", "en", "km", "zh", "fr"]), `s${int(1, 40000)}`, null,
         new Date(now - daysAgo * 86400000 - int(0, 23) * 3600000)]);
      leadCount++;
    }
  }
  console.log(`  ${viewCount} vues, ${leadCount} contacts`);

  // Les compteurs dénormalisés utilisés par la page d'accueil et les filtres.
  await db.query(`
    UPDATE locations SET listing_count = sub.n FROM (
      SELECT loc.id, count(DISTINCT p.id) AS n
      FROM locations loc
      JOIN locations descendant ON descendant.id = loc.id
        OR descendant.parent_id = loc.id
        OR descendant.parent_id IN (SELECT id FROM locations WHERE parent_id = loc.id)
      JOIN properties p ON p.location_id = descendant.id
      JOIN listings l ON l.property_id = p.id AND l.status = 'active'
      GROUP BY loc.id
    ) sub WHERE locations.id = sub.id`);

  // File de déduplication : signatures identiques entre biens distincts.
  await db.query(`
    INSERT INTO dedup_candidates(property_a_id, property_b_id, score, reasons)
    SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 0.82, ARRAY['signature_identique']
    FROM properties a JOIN properties b
      ON a.dedup_signature = b.dedup_signature AND a.id < b.id
    ON CONFLICT DO NOTHING`);

  // ------------------------------------- Vérification des titres (phase 4)
  // Des partenaires juridiques et un dossier à chaque étape du cycle, pour que
  // le panneau de modération et le badge public aient chacun quelque chose à
  // montrer. La conclusion confirmée alimente le badge du bien.
  const partners = [];
  for (const [slug, name, contact] of [
    ["bng-legal", "BNG Legal", "titles@bnglegal.com"],
    ["dfdl-cambodia", "DFDL Cambodia", "realestate@dfdl.com"],
    ["sok-siphana", "Sok Siphana & Associates", "land@soksiphana.com"],
  ]) {
    const { rows } = await db.query(
      `INSERT INTO verification_partners(slug, name, contact) VALUES ($1,$2,$3)
       RETURNING id, name`, [slug, name, contact]);
    partners.push(rows[0]);
  }

  // Quatre condos strata en vente, BKK1 d'abord : un dossier par état.
  const { rows: verifiable } = await db.query(`
    SELECT p.id, p.reference, p.title_type::text AS claimed
    FROM properties p
    JOIN locations loc ON loc.id = p.location_id
    WHERE p.property_type = 'condo' AND p.title_type = 'strata'
      AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = p.id
                    AND l.status = 'active' AND l.transaction_type = 'sale')
    ORDER BY loc.slug = 'bkk1' DESC, p.reference LIMIT 4`);

  let dossierCount = 0;
  const dossier = (property, partner, fields) => db.query(
    `INSERT INTO title_verifications(property_id, partner_id, property_reference,
       partner_name, claimed_title, status, requested_by, requested_at,
       documents_received_at, concluded_at, confirmed_title, note)
     VALUES ($1,$2,$3,$4,$5::title_type,$6,$7,
             now() - make_interval(days => $8),
             CASE WHEN $9::int  IS NULL THEN NULL ELSE now() - make_interval(days => $9::int)  END,
             CASE WHEN $10::int IS NULL THEN NULL ELSE now() - make_interval(days => $10::int) END,
             $11::title_type, $12)`,
    [property.id, partner.id, property.reference, partner.name, property.claimed,
     fields.status, "seed@khmerestate.kh", fields.requestedDays,
     fields.documentsDays ?? null, fields.concludedDays ?? null,
     fields.confirmedTitle ?? null, fields.note ?? null]).then(() => dossierCount++);

  if (verifiable.length >= 4) {
    const [confirmed, rejected, inReview, requested] = verifiable;
    await dossier(confirmed, partners[0], {
      status: "confirmed", requestedDays: 20, documentsDays: 16, concludedDays: 12,
      confirmedTitle: confirmed.claimed,
      note: "Titre strata inscrit au registre foncier, sans charge.",
    });
    await db.query(
      `UPDATE properties SET title_verified_at = now() - interval '12 days',
              title_verified_by = $2 WHERE id = $1`,
      [confirmed.id, partners[0].name]);
    await dossier(rejected, partners[1], {
      status: "rejected", requestedDays: 30, concludedDays: 9,
      note: "Documents jamais fournis par l'agence.",
    });
    await dossier(inReview, partners[1], {
      status: "in_review", requestedDays: 8, documentsDays: 5,
    });
    await dossier(requested, partners[2], { status: "requested", requestedDays: 2 });
  }
  console.log(`  ${partners.length} partenaires, ${dossierCount} dossiers de titre`);
}

// Exécution directe : rejouer l'activité sur les biens présents en base.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL
      ?? "postgres://immo:immo@localhost:5433/cambodia_immo",
  });
  await client.connect();
  // Hors du seed, le déterminisme n'a plus d'objet : les biens ne sont pas
  // les mêmes d'une exécution à l'autre.
  let seed = 0x9e3779b9;
  const rnd = () => (((seed = (seed + 0x6d2b79f5) | 0), (() => {
    let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  })()));
  await seedActivity(client, {
    rnd,
    pick: (a) => a[Math.floor(rnd() * a.length)],
    int: (min, max) => min + Math.floor(rnd() * (max - min + 1)),
    now: Date.now(),
  });
  await client.end();
}
