"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { queryOne, withTransaction } from "@/lib/db";
import { AuthError, requireUser, type SessionUser } from "@/lib/auth";
import { actorFromUser, recordAudit } from "@/lib/audit";
// Socle d'ingestion en ESM simple, partagé avec les jobs : la même logique
// sert au flux XML, au bot et au back-office.
import { completeSubmission } from "../../../../db/lib/ingest.mjs";
import { FEATURED_DAYS, issueInvoiceFor, releaseHeld }
  from "../../../../db/lib/billing.mjs";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";

/** Les formulaires du back-office fonctionnent sans JavaScript : le retour
 *  d'erreur passe par l'URL, pas par un état React. */
function fail(locale: string, code: string): never {
  redirect(`/${locale}/backoffice?error=${code}`);
}

function localeOf(form: FormData): string {
  const raw = String(form.get("locale") ?? DEFAULT_LOCALE);
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/**
 * Garde d'entrée de toute action du back-office.
 *
 * Une action serveur est un point d'entrée POST autonome : elle reste
 * atteignable par quiconque connaît son identifiant, indépendamment de la page
 * qui la contient. La garde du layout ne la protège donc pas — chaque action
 * doit vérifier la session elle-même.
 */
async function guard(locale: string, role: "any" | "admin" = "any"): Promise<SessionUser> {
  let user: SessionUser;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError) {
      redirect(`/${locale}/login?error=sessionExpired&next=/${locale}/backoffice`);
    }
    throw err;
  }
  if (role === "admin" && user.role !== "admin") fail(locale, "forbidden");
  return user;
}

/**
 * Création d'un bien depuis le back-office. Le back-office n'est pas le canal
 * principal de saisie (§6.1) — il sert aux corrections, aux comptes premium et
 * à la modération — mais il applique les mêmes règles que le bot Telegram :
 * pas de pin, pas d'enregistrement.
 */
export async function createProperty(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale);

  const lng = Number(form.get("lng"));
  const lat = Number(form.get("lat"));

  // Étape bloquante (principe n°2). Aucun repli sur un géocodage d'adresse :
  // le contrôle est refait ici, côté serveur, car le bouton désactivé du
  // client ne protège rien.
  if (!form.get("lng") || !form.get("lat") || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    fail(locale, "pin_required");
  }

  const locationSlug = String(form.get("location") ?? "");
  const agentId = String(form.get("agent") ?? "");
  const propertyType = String(form.get("property_type") ?? "condo");
  const transaction = form.get("transaction") === "rent" ? "rent" : "sale";
  const price = Number(form.get("price"));
  const floorRaw = form.get("floor");
  const floor = floorRaw === "" || floorRaw === null ? null : Number(floorRaw);
  const description = String(form.get("description") ?? "").slice(0, 2000);
  const sourceLang = String(form.get("source_lang") ?? "en");

  if (!locationSlug || !agentId || !Number.isFinite(price) || price <= 0) {
    fail(locale, "invalid_input");
  }

  const location = await queryOne<{ id: string }>(
    `SELECT id FROM locations WHERE slug = $1`, [locationSlug]);
  const agent = await queryOne<{ id: string; agency_id: string; agency_name: string }>(
    `SELECT ag.id, ag.agency_id, a.name AS agency_name
     FROM agents ag JOIN agencies a ON a.id = ag.agency_id WHERE ag.id = $1`, [agentId]);
  if (!location || !agent) fail(locale, "invalid_input");

  // Un compte d'agence ne publie que sous sa propre agence, quel que soit
  // l'identifiant d'agent posté dans le formulaire.
  if (user.role !== "admin" && agent.agency_id !== user.agencyId) fail(locale, "forbidden");

  // Quota d'abonnement (§8). Contrairement aux canaux automatiques — où une
  // annonce excédentaire est retenue pour ne pas jeter la donnée reçue — une
  // saisie interactive se refuse tout de suite : rien n'est perdu, et la
  // personne au clavier peut réagir. La règle verrouillée est réappliquée par
  // l'ingestion pour les autres canaux.
  const quota = await queryOne<{ full: boolean }>(
    `SELECT (SELECT count(*) FROM listings l
              WHERE l.agency_id = a.id AND l.status = 'active') >= a.listing_quota AS full
     FROM agencies a WHERE a.id = $1`, [agent.agency_id]);
  if (quota?.full) fail(locale, "quota_exceeded");

  let reference: string;
  try {
    reference = await withTransaction(async (client) => {
      const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
      const ref = `${locationSlug.slice(0, 2).toUpperCase()}-${suffix}${Date.now() % 1000}`;

      const { rows } = await client.query(
        `INSERT INTO properties(reference, property_type, location_id, geo_point,
           geo_pin_by, geo_pin_at, floor, bedrooms, bathrooms, indoor_area_sqm,
           land_area_sqm, title_type, furnished, verified_at)
         VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326), $6, now(), $7,$8,$9,$10,$11,$12,$13, now())
         RETURNING id`,
        [ref, propertyType, location.id, lng, lat, `back-office:${user.email}`, floor,
         Number(form.get("bedrooms") ?? 0) || 0,
         Number(form.get("bathrooms") ?? 0) || 0,
         Number(form.get("indoor_area") ?? 0) || null,
         Number(form.get("land_area") ?? 0) || null,
         String(form.get("title_type") ?? "unknown"),
         form.get("furnished") === "1"]
      );
      const propertyId = rows[0].id as string;

      // La description est saisie dans une seule langue ; les traductions sont
      // produites à l'ingestion, pas à l'affichage (§4.1).
      const { rows: listingRows } = await client.query(
        `INSERT INTO listings(property_id, agency_id, agent_id, transaction_type, price_usd,
           price_period, status, source, description_i18n, description_source_lang,
           translation_status)
         VALUES ($1,$2,$3,$4,$5,$6,'active','backoffice',$7,$8,
                 CASE WHEN $9::text = '' THEN 'not_needed' ELSE 'pending' END::translation_status)
         RETURNING id`,
        [propertyId, agent.agency_id, agent.id, transaction, price,
         transaction === "rent" ? "monthly" : "total",
         JSON.stringify({ [sourceLang]: description }), sourceLang, description.trim()]
      );

      await recordAudit(client, actorFromUser(user), {
        action: "property_created",
        targetType: "property",
        targetId: propertyId,
        targetLabel: ref,
        details: {
          propertyType,
          transaction,
          priceUsd: price,
          agency: agent.agency_name,
          listingId: listingRows[0].id,
          // Le pin est tracé avec l'action : c'est l'étape bloquante du
          // processus, sa provenance doit être vérifiable.
          pin: { lng, lat },
          locationSlug,
        },
      });

      return ref;
    });
  } catch {
    fail(locale, "db_error");
  }

  revalidatePath("/[locale]/backoffice", "page");
  redirect(`/${locale}/property/${reference}`);
}

/**
 * Tranche un cas de la file de déduplication (§6.2). Jamais automatique, et
 * réservé à la modération : fusionner deux biens touche les annonces d'agences
 * tierces.
 */
export async function resolveDedup(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const id = Number(form.get("id"));
  const decision = String(form.get("decision"));
  if (!Number.isFinite(id) || !["merged", "distinct"].includes(decision)) return;

  await withTransaction(async (client) => {
    // Le verrou évite que deux modérateurs tranchent le même cas en parallèle
    // et produisent deux entrées de journal pour une seule décision.
    const { rows } = await client.query(
      `SELECT d.id, d.score, d.property_a_id AS a, d.property_b_id AS b,
              pa.reference AS a_ref, pb.reference AS b_ref
       FROM dedup_candidates d
       JOIN properties pa ON pa.id = d.property_a_id
       JOIN properties pb ON pb.id = d.property_b_id
       WHERE d.id = $1 AND d.reviewed_at IS NULL
       FOR UPDATE OF d`,
      [id]);
    const pair = rows[0];
    if (!pair) return;

    let listingsMoved = 0;
    let dropped: { agency: string; transaction: string; price: string }[] = [];
    if (decision === "merged") {
      // Les annonces du doublon sont rattachées au bien conservé. Celles qui
      // entrent en collision avec une annonce existante — même agence, même
      // type de transaction — restent en arrière : la contrainte d'unicité les
      // écarte, et elles disparaissent ensuite avec le bien en cascade.
      const moved = await client.query(
        `UPDATE listings SET property_id = $1 WHERE property_id = $2
           AND NOT EXISTS (SELECT 1 FROM listings k WHERE k.property_id = $1
             AND k.agency_id = listings.agency_id
             AND k.transaction_type = listings.transaction_type AND k.status = 'active')
         RETURNING id`,
        [pair.a, pair.b]);
      listingsMoved = moved.rowCount ?? 0;

      // Une fusion détruit des annonces. Le journal doit dire lesquelles :
      // c'est précisément ce qu'une agence viendra contester.
      const { rows: casualties } = await client.query(
        `SELECT a.name AS agency, l.transaction_type::text AS transaction,
                l.price_usd::text AS price
         FROM listings l JOIN agencies a ON a.id = l.agency_id
         WHERE l.property_id = $1`,
        [pair.b]);
      dropped = casualties;

      await client.query(`DELETE FROM properties WHERE id = $1`, [pair.b]);
    }

    await client.query(
      `UPDATE dedup_candidates SET reviewed_at = now(), decision = $2 WHERE id = $1`,
      [id, decision]);

    await recordAudit(client, actorFromUser(user), {
      action: decision === "merged" ? "dedup_merged" : "dedup_distinct",
      targetType: "dedup_candidate",
      targetId: String(id),
      // Le bien supprimé n'existera plus : sa référence n'est lisible que si
      // elle est figée ici.
      targetLabel: `${pair.a_ref} ↔ ${pair.b_ref}`,
      details: {
        score: Number(pair.score),
        keptReference: pair.a_ref,
        keptId: pair.a,
        ...(decision === "merged"
          ? {
              removedReference: pair.b_ref,
              removedId: pair.b,
              listingsMoved,
              listingsDropped: dropped.length,
              droppedDetail: dropped,
            }
          : {}),
      },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}

/** Ajoute un terme non résolu comme alias d'une localité (§5.2, §10). */
export async function addAlias(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const missId = Number(form.get("miss_id"));
  const slug = String(form.get("slug") ?? "");
  const term = String(form.get("term") ?? "").trim().toLowerCase();
  if (!slug || !term) return;

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE locations SET aliases = array_append(aliases, $2)
       WHERE slug = $1 AND NOT ($2 = ANY(aliases))
       RETURNING id, name_i18n`,
      [slug, term]);
    // Alias déjà présent ou localité inconnue : rien à journaliser.
    if (rows.length === 0) return;

    if (Number.isFinite(missId)) {
      await client.query(`UPDATE search_misses SET resolved = true WHERE id = $1`, [missId]);
    }

    await recordAudit(client, actorFromUser(user), {
      action: "alias_added",
      targetType: "location",
      targetId: rows[0].id,
      targetLabel: slug,
      details: { term, searchMissId: Number.isFinite(missId) ? missId : null },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}

/** Relance J-7 : « toujours disponible ? » en un clic (§6.3). */
export async function confirmListing(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale);

  const id = String(form.get("listing_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;

  await withTransaction(async (client) => {
    // Une agence ne reconfirme que ses propres annonces. La condition est
    // portée par la requête elle-même : pas de lecture puis écriture, donc pas
    // de fenêtre entre les deux. Rien mis à jour, rien journalisé.
    const { rows } = await client.query(
      `UPDATE listings
       SET last_confirmed_at = now(), expires_at = now() + interval '45 days'
       WHERE id = $1 AND status = 'active'
         AND ($2::uuid IS NULL OR agency_id = $2::uuid)
       RETURNING property_id, expires_at, agency_id`,
      [id, user.role === "admin" ? null : user.agencyId]);
    if (rows.length === 0) return;

    const listing = rows[0];
    const { rows: prop } = await client.query(
      `SELECT p.reference, a.name AS agency
       FROM properties p, agencies a WHERE p.id = $1 AND a.id = $2`,
      [listing.property_id, listing.agency_id]);

    await recordAudit(client, actorFromUser(user), {
      action: "listing_confirmed",
      targetType: "listing",
      targetId: id,
      targetLabel: prop[0]?.reference ?? null,
      details: {
        agency: prop[0]?.agency ?? null,
        newExpiry: listing.expires_at,
      },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}


/**
 * Pose le pin manquant sur une soumission venue d'un flux ou du bot (§6.1).
 *
 * C'est l'étape bloquante, déplacée d'un cran : le canal d'ingestion a pu
 * apporter tous les champs, mais tant que personne n'a pointé le bien sur la
 * carte, il n'existe pas.
 */
export async function pinSubmission(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale);

  const submissionId = String(form.get("submission_id") ?? "");
  const lng = Number(form.get("lng"));
  const lat = Number(form.get("lat"));

  if (!/^[0-9a-f-]{36}$/i.test(submissionId)) fail(locale, "invalid_input");
  if (!form.get("lng") || !form.get("lat") || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    fail(locale, "pin_required");
  }

  let reference: string | null = null;
  try {
    reference = await withTransaction(async (client) => {
      // Une agence ne complète que ses propres soumissions.
      const owner = await client.query(
        `SELECT agency_id FROM submissions WHERE id = $1`, [submissionId]);
      if (owner.rows.length === 0) return null;
      if (user.role !== "admin" && owner.rows[0].agency_id !== user.agencyId) {
        throw new AuthError("forbidden");
      }

      const outcome = await completeSubmission(
        client, submissionId, { lng, lat }, `back-office:${user.email}`);
      if (outcome.status !== "accepted") return null;

      await recordAudit(client, actorFromUser(user), {
        action: "property_created",
        targetType: "property",
        targetId: outcome.propertyId,
        targetLabel: outcome.reference,
        details: {
          via: "submission",
          submissionId,
          dedupDecision: outcome.decision,
          dedupScore: outcome.score,
          reasons: outcome.reasons,
          pin: { lng, lat },
        },
      });
      return outcome.reference as string;
    });
  } catch (err) {
    if (err instanceof AuthError) fail(locale, "forbidden");
    fail(locale, "db_error");
  }

  revalidatePath("/[locale]/backoffice", "page");
  if (reference) redirect(`/${locale}/property/${reference}`);
  fail(locale, "invalid_input");
}

/**
 * Valide une traduction machine (§4.1 : relecture humaine des annonces
 * premium). La fiche publique cesse alors d'afficher le marqueur
 * « traduction automatique », puisque celui-ci découle de l'état.
 */
export async function approveTranslation(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const listingId = String(form.get("listing_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return;

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE listings SET translation_status = 'human_reviewed'
       WHERE id = $1 AND translation_status = 'machine'
       RETURNING property_id`, [listingId]);
    if (rows.length === 0) return;

    const { rows: prop } = await client.query(
      `SELECT reference FROM properties WHERE id = $1`, [rows[0].property_id]);

    await recordAudit(client, actorFromUser(user), {
      action: "translation_reviewed",
      targetType: "listing",
      targetId: listingId,
      targetLabel: prop[0]?.reference ?? null,
      details: {},
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}

// ---------------------------------------------------------------------------
// Abonnements, factures et mise en avant (§8)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f-]{36}$/i;
const TIERS = ["free", "standard", "premium"] as const;

/**
 * Change le palier d'une agence. Les quotas effectifs sont réalignés sur les
 * valeurs du nouveau palier — un accord sur mesure se règle ensuite par un
 * ajustement direct, le palier reste la référence.
 *
 * À la baisse, les annonces actives excédentaires RESTENT actives : couper
 * des annonces en ligne parce qu'un paiement a changé serait une sanction
 * commerciale, pas une règle de quota. L'excédent bloque simplement toute
 * nouvelle publication jusqu'à résorption. Les mises en avant excédentaires,
 * elles, s'éteignent : c'est un produit facturé au palier.
 */
export async function changeTier(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const agencyId = String(form.get("agency_id") ?? "");
  const tier = String(form.get("tier") ?? "");
  if (!UUID.test(agencyId) || !(TIERS as readonly string[]).includes(tier)) {
    fail(locale, "invalid_input");
  }

  await withTransaction(async (client) => {
    const { rows: before } = await client.query(
      `SELECT name, subscription_tier::text AS tier, listing_quota, featured_quota
       FROM agencies WHERE id = $1 FOR UPDATE`, [agencyId]);
    if (before.length === 0) return;
    if (before[0].tier === tier) return;

    const { rows: [plan] } = await client.query(
      `SELECT listing_quota, featured_slots FROM plans WHERE tier = $1::subscription_tier`,
      [tier]);

    await client.query(
      `UPDATE agencies SET subscription_tier = $2::subscription_tier,
              listing_quota = $3, featured_quota = $4
       WHERE id = $1`,
      [agencyId, tier, plan.listing_quota, plan.featured_slots]);

    // Mises en avant au-delà du nouveau quota : les plus proches de leur
    // échéance s'éteignent d'abord — ce sont celles qui perdent le moins.
    const { rows: unfeatured } = await client.query(
      `UPDATE listings SET featured = false, updated_at = now()
       WHERE id IN (
         SELECT id FROM listings
         WHERE agency_id = $1 AND status = 'active' AND featured
         ORDER BY featured_until OFFSET $2)
       RETURNING id`,
      [agencyId, plan.featured_slots]);

    // Une montée de palier libère des places : les annonces retenues partent
    // tout de suite, sans attendre le passage du job quotidien.
    const released = await releaseHeld(client, agencyId);

    await recordAudit(client, actorFromUser(user), {
      action: "tier_changed",
      targetType: "agency",
      targetId: agencyId,
      targetLabel: before[0].name,
      details: {
        from: before[0].tier, to: tier,
        listingQuota: plan.listing_quota, featuredQuota: plan.featured_slots,
        released, unfeatured: unfeatured.length,
      },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}

/** Émet la facture du mois courant pour une agence, hors passage du job. */
export async function issueInvoice(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const agencyId = String(form.get("agency_id") ?? "");
  if (!UUID.test(agencyId)) fail(locale, "invalid_input");

  let issued = false;
  await withTransaction(async (client) => {
    const invoice = await issueInvoiceFor(client, agencyId);
    if (!invoice) return; // palier gratuit, ou période déjà facturée

    issued = true;
    await recordAudit(client, actorFromUser(user), {
      action: "invoice_issued",
      targetType: "invoice",
      targetId: invoice.id,
      targetLabel: invoice.number,
      details: {
        agency: invoice.agencyName, tier: invoice.tier,
        amountUsd: Number(invoice.amountUsd), periodStart: invoice.periodStart,
      },
    });
  });

  if (!issued) fail(locale, "invoice_not_issued");
  revalidatePath("/[locale]/backoffice", "page");
}

/**
 * Pointe une facture réglée. Le règlement arrive hors ligne (virement,
 * espèces) : la référence saisie ici est la seule passerelle vers la trace
 * bancaire, elle est donc conservée sur la facture ET dans le journal.
 */
export async function markInvoicePaid(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const invoiceId = String(form.get("invoice_id") ?? "");
  const note = String(form.get("note") ?? "").trim().slice(0, 200) || null;
  if (!UUID.test(invoiceId)) return;

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices SET status = 'paid', paid_at = now(), paid_note = $2
       WHERE id = $1 AND status = 'issued'
       RETURNING number, agency_name, amount_usd`, [invoiceId, note]);
    if (rows.length === 0) return;

    await recordAudit(client, actorFromUser(user), {
      action: "invoice_paid",
      targetType: "invoice",
      targetId: invoiceId,
      targetLabel: rows[0].number,
      details: { agency: rows[0].agency_name, amountUsd: Number(rows[0].amount_usd), note },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}

/** Annule une facture émise par erreur. Jamais de suppression : la
 *  numérotation doit rester continue et vérifiable. */
export async function voidInvoice(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const invoiceId = String(form.get("invoice_id") ?? "");
  if (!UUID.test(invoiceId)) return;

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices SET status = 'void'
       WHERE id = $1 AND status = 'issued'
       RETURNING number, agency_name, amount_usd`, [invoiceId]);
    if (rows.length === 0) return;

    await recordAudit(client, actorFromUser(user), {
      action: "invoice_voided",
      targetType: "invoice",
      targetId: invoiceId,
      targetLabel: rows[0].number,
      details: { agency: rows[0].agency_name, amountUsd: Number(rows[0].amount_usd) },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}

/**
 * Active ou éteint la mise en avant d'une annonce (§8), dans la limite des
 * emplacements du palier. Accessible à l'agence depuis son tableau de bord :
 * c'est elle qui choisit quoi pousser, pas la modération.
 */
export async function toggleFeatured(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale);

  const listingId = String(form.get("listing_id") ?? "");
  const on = form.get("on") === "1";
  // Le formulaire vit sur le tableau de bord : l'erreur y retourne.
  const back = `/${locale}/dashboard`;
  if (!UUID.test(listingId)) redirect(back);

  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT l.agency_id, l.status::text AS status, l.featured, p.reference,
                a.name AS agency, a.featured_quota
         FROM listings l
         JOIN properties p ON p.id = l.property_id
         JOIN agencies a ON a.id = l.agency_id
         WHERE l.id = $1 FOR UPDATE OF l`, [listingId]);
      if (rows.length === 0) return;
      const listing = rows[0];

      if (user.role !== "admin" && listing.agency_id !== user.agencyId) {
        throw new AuthError("forbidden");
      }

      if (on) {
        if (listing.status !== "active" || listing.featured) return;
        // Le verrou d'agence sérialise deux activations concurrentes qui
        // viseraient le dernier emplacement.
        await client.query(`SELECT 1 FROM agencies WHERE id = $1 FOR UPDATE`,
          [listing.agency_id]);
        const { rows: [{ used }] } = await client.query(
          `SELECT count(*)::int AS used FROM listings
           WHERE agency_id = $1 AND status = 'active' AND featured`,
          [listing.agency_id]);
        if (used >= listing.featured_quota) throw new Error("slots_full");

        const { rows: [updated] } = await client.query(
          `UPDATE listings SET featured = true,
                  featured_until = now() + make_interval(days => $2),
                  updated_at = now()
           WHERE id = $1 RETURNING featured_until`, [listingId, FEATURED_DAYS]);

        await recordAudit(client, actorFromUser(user), {
          action: "listing_featured",
          targetType: "listing",
          targetId: listingId,
          targetLabel: listing.reference,
          details: { agency: listing.agency, until: updated.featured_until, days: FEATURED_DAYS },
        });
      } else {
        if (!listing.featured) return;
        // `featured_until` est conservé : trace de ce qui a été acheté.
        await client.query(
          `UPDATE listings SET featured = false, updated_at = now() WHERE id = $1`,
          [listingId]);

        await recordAudit(client, actorFromUser(user), {
          action: "listing_unfeatured",
          targetType: "listing",
          targetId: listingId,
          targetLabel: listing.reference,
          details: { agency: listing.agency },
        });
      }
    });
  } catch (err) {
    if (err instanceof AuthError) redirect(`${back}?error=forbidden`);
    if (err instanceof Error && err.message === "slots_full") {
      redirect(`${back}?error=featured_slots`);
    }
    throw err;
  }

  revalidatePath("/[locale]/dashboard", "page");
  redirect(back);
}

const VERIFICATIONS = ["unverified", "documents_received", "verified"] as const;

/**
 * Change le statut de vérification d'une agence (phase 3).
 *
 * Le badge « agence vérifiée » n'a de valeur que si son attribution est
 * traçable : le passage par les trois états (non vérifiée → documents reçus →
 * vérifiée) est journalisé avec l'auteur, comme tout ce qui touche à la
 * confiance affichée aux visiteurs.
 */
export async function setVerification(form: FormData) {
  const locale = localeOf(form);
  const user = await guard(locale, "admin");

  const agencyId = String(form.get("agency_id") ?? "");
  const status = String(form.get("status") ?? "");
  if (!UUID.test(agencyId) || !(VERIFICATIONS as readonly string[]).includes(status)) {
    fail(locale, "invalid_input");
  }

  await withTransaction(async (client) => {
    const { rows: before } = await client.query(
      `SELECT name, verification_status::text AS status FROM agencies
       WHERE id = $1 FOR UPDATE`, [agencyId]);
    if (before.length === 0 || before[0].status === status) return;

    await client.query(
      `UPDATE agencies SET verification_status = $2::verification_status WHERE id = $1`,
      [agencyId, status]);

    await recordAudit(client, actorFromUser(user), {
      action: "verification_changed",
      targetType: "agency",
      targetId: agencyId,
      targetLabel: before[0].name,
      details: { from: before[0].status, to: status },
    });
  });

  revalidatePath("/[locale]/backoffice", "page");
}
