/**
 * Les formes que la base réelle n'a pas.
 *
 * Les contrôles vérifient du code, pas la forme d'un jeu de données. Or la
 * base issue de `setup:real` — des annonces collectées sur un portail public —
 * ne porte pas certaines formes que le jeu engendré par `db:seed` fournissait
 * gratuitement : un bien rattaché à un immeuble, deux agences sur le même
 * bien, une annonce d'agence premium, un dossier de titre confirmé. Six
 * contrôles échouaient là-dessus sans qu'aucun défaut n'existe, et six lignes
 * rouges permanentes finissent par cacher la septième, qui elle compte.
 *
 * Chaque fonction fabrique la forme voulue et rend un `release()` qui la
 * défait. Deux régimes, dictés par le lecteur :
 *
 *   — dans une transaction annulée, quand seul le contrôle lit la base. Rien
 *     n'est validé, il n'y a rien à nettoyer ;
 *   — validé puis retiré, quand c'est le serveur web qui doit voir la donnée :
 *     il lit sur sa propre connexion et ne verra jamais une transaction
 *     ouverte ailleurs.
 *
 * Le régime validé écrit dans la base de développement. Les objets créés
 * portent le préfixe `chk-` : `sweep()` retire ceux qu'un contrôle interrompu
 * aurait laissés, pour que l'exécution suivante reparte propre.
 */

const PREFIX = "chk-";
const tag = () => PREFIX + Math.random().toString(36).slice(2, 8);

/**
 * Retire les fixtures qu'une exécution interrompue aurait laissées.
 *
 * Un contrôle tué entre la création et le `release()` laisse un immeuble
 * `chk-…` en base : il apparaîtrait sur le hub des projets et dans le sitemap.
 * Chaque contrôle balaie avant de commencer.
 */
export async function sweep(db) {
  await db.query(
    `UPDATE properties SET building_id = NULL
     WHERE building_id IN (SELECT id FROM buildings WHERE slug LIKE $1)`, [PREFIX + "%"]);
  const { rowCount } = await db.query(`DELETE FROM buildings WHERE slug LIKE $1`, [PREFIX + "%"]);
  return rowCount;
}

/**
 * Un immeuble portant de vraies annonces à vendre.
 *
 * Rattache des biens réels à un immeuble neuf plutôt qu'à l'un des vingt-deux
 * déjà en base : un slug jamais vu ne peut pas être servi depuis le cache de
 * page (`revalidate = 900`), là où un immeuble connu renverrait la version
 * d'avant la fixture. L'immeuble est posé dans le quartier des biens choisis,
 * et son point est leur barycentre — le principe n°2 interdit d'inventer une
 * position, celle-ci est déduite de pins existants.
 *
 * Rend `null` si la base n'a pas de quoi le faire (aucune annonce à vendre).
 */
export async function buildingWithListings(db, { count = 4 } = {}) {
  const { rows: [spot] } = await db.query(`
    SELECT p.location_id, count(*)::int AS n
    FROM properties p
    JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'sale'
    WHERE p.building_id IS NULL
    GROUP BY p.location_id ORDER BY n DESC LIMIT 1`);
  if (!spot || spot.n < 1) return null;

  const slug = tag();
  const name = "Contrôle " + slug.slice(PREFIX.length);
  const { rows: [building] } = await db.query(`
    INSERT INTO buildings(slug, name_i18n, location_id, geo_point, status,
                          total_floors, total_units, completion_year)
    SELECT $1, jsonb_build_object('fr', $2::text, 'en', $2::text, 'zh-Hans', $2::text, 'km', $2::text),
           $3, ST_SetSRID(ST_Centroid(ST_Collect(p.geo_point)), 4326), 'completed', 24, 180, 2021
    FROM properties p
    WHERE p.location_id = $3 AND p.building_id IS NULL
      AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = p.id
                    AND l.status = 'active' AND l.transaction_type = 'sale')
    RETURNING id, slug`, [slug, name, spot.location_id]);

  const { rows: taken } = await db.query(`
    UPDATE properties SET building_id = $1
    WHERE id IN (
      SELECT p.id FROM properties p
      JOIN listings l ON l.property_id = p.id AND l.status = 'active' AND l.transaction_type = 'sale'
      WHERE p.location_id = $2 AND p.building_id IS NULL
      ORDER BY p.reference LIMIT $3)
    RETURNING id`, [building.id, spot.location_id, count]);

  return {
    id: building.id,
    slug: building.slug,
    name,
    properties: taken.length,
    release: async () => {
      await db.query(`UPDATE properties SET building_id = NULL WHERE building_id = $1`, [building.id]);
      await db.query(`DELETE FROM buildings WHERE id = $1`, [building.id]);
    },
  };
}

/** Le demandeur inscrit sur les dossiers de contrôle : c'est lui qui les rend
 *  reconnaissables au balayage. */
const CHECK_REQUESTER = "checks@example.test";

/**
 * Retire les dossiers de titre qu'une exécution interrompue aurait laissés.
 *
 * Celui-ci compte plus que le balayage des immeubles : un dossier confirmé
 * pose un badge « titre vérifié » sur une vraie annonce, publiquement. Un
 * `finally` le retire en fin de contrôle ; ce balayage rattrape le cas où le
 * processus a été tué entre les deux.
 */
export async function sweepTitles(db) {
  await db.query(`
    UPDATE properties SET title_verified_at = NULL, title_verified_by = NULL
    WHERE id IN (SELECT property_id FROM title_verifications WHERE requested_by = $1)`,
    [CHECK_REQUESTER]);
  const { rowCount } = await db.query(
    `DELETE FROM title_verifications WHERE requested_by = $1`, [CHECK_REQUESTER]);
  return rowCount;
}

/**
 * Un dossier de titre confirmé sur la fiche d'un bien réel.
 *
 * Le bien est tiré au hasard : sa fiche (`revalidate = 120`) a d'autant moins
 * de chances d'être en cache qu'elle est une parmi des milliers, là où un bien
 * choisi par un `ORDER BY` stable serait le même à chaque exécution — donc en
 * cache à la deuxième.
 */
export async function confirmedTitle(db) {
  const { rows: [partner] } = await db.query(`SELECT id, name FROM verification_partners LIMIT 1`);
  const { rows: [property] } = await db.query(`
    SELECT p.id, p.reference, p.title_type::text AS title
    FROM properties p
    WHERE p.title_type <> 'unknown'
      AND p.title_verified_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM title_verifications v WHERE v.property_id = p.id)
      AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = p.id AND l.status = 'active')
    ORDER BY random() LIMIT 1`);
  if (!partner || !property) return null;

  const { rows: [dossier] } = await db.query(`
    INSERT INTO title_verifications(property_id, partner_id, property_reference, partner_name,
                                    claimed_title, status, requested_by, confirmed_title, concluded_at)
    VALUES ($1, $2, $3, $4, $5::title_type, 'confirmed', $6, $5::title_type, now())
    RETURNING id`,
    [property.id, partner.id, property.reference, partner.name, property.title, CHECK_REQUESTER]);
  await db.query(
    `UPDATE properties SET title_verified_at = now(), title_verified_by = $2 WHERE id = $1`,
    [property.id, partner.name]);

  return {
    reference: property.reference,
    partner: partner.name,
    release: async () => {
      await db.query(`DELETE FROM title_verifications WHERE id = $1`, [dossier.id]);
      await db.query(
        `UPDATE properties SET title_verified_at = NULL, title_verified_by = NULL WHERE id = $1`,
        [property.id]);
    },
  };
}

/**
 * Une annonce d'agence premium, et c'est la plus récente de la base.
 *
 * À appeler dans une transaction annulée. Le choix de la plus récente n'est pas
 * décoratif : la file de traduction ordonne par premium puis par ancienneté, si
 * bien qu'une annonce à la fois premium et la plus vieille sortirait en tête
 * même sans la priorité. Celle-ci ne peut passer devant que par elle.
 */
export async function premiumListing(db) {
  const { rows: [agency] } = await db.query(`
    SELECT a.id, (SELECT ag.id FROM agents ag WHERE ag.agency_id = a.id LIMIT 1) AS agent_id
    FROM agencies a
    WHERE a.subscription_tier = 'premium'
      AND EXISTS (SELECT 1 FROM agents ag WHERE ag.agency_id = a.id)
    LIMIT 1`);
  if (!agency) return null;
  const { rows: [listing] } = await db.query(`
    UPDATE listings SET agency_id = $1, agent_id = $2
    WHERE id = (SELECT l.id FROM listings l
                WHERE coalesce(trim(l.description_i18n->>l.description_source_lang::text), '') <> ''
                ORDER BY l.created_at DESC, l.id LIMIT 1)
    RETURNING id, (SELECT p.reference FROM properties p WHERE p.id = property_id) AS reference`,
    [agency.id, agency.agent_id]);
  return listing ?? null;
}

/**
 * Un même bien proposé par deux agences.
 *
 * À appeler dans une transaction annulée. Le bien est pris parmi ceux qui ont
 * déjà été vus : le contrôle vérifie qu'une vue profite aux deux agences, ce
 * qui suppose une vue à partager.
 */
export async function sharedProperty(db) {
  const { rows: [seed] } = await db.query(`
    SELECT l.id AS listing_id, l.property_id, l.agency_id
    FROM listings l
    WHERE l.status = 'active'
      AND EXISTS (SELECT 1 FROM property_views v WHERE v.property_id = l.property_id)
    ORDER BY l.property_id LIMIT 1`);
  if (!seed) return null;
  const { rows: [other] } = await db.query(`
    SELECT a.id, (SELECT ag.id FROM agents ag WHERE ag.agency_id = a.id LIMIT 1) AS agent_id
    FROM agencies a
    WHERE a.id <> $1 AND EXISTS (SELECT 1 FROM agents ag WHERE ag.agency_id = a.id)
    LIMIT 1`, [seed.agency_id]);
  if (!other) return null;
  // Même bien, même transaction, autre agence : l'unicité porte sur le triplet
  // (bien, agence, transaction), deux agences peuvent donc proposer le même
  // bien — c'est exactement la situation que le contrôle mesure.
  await db.query(`
    INSERT INTO listings(property_id, agency_id, agent_id, transaction_type, price_usd,
                         price_period, status, description_i18n, description_source_lang)
    SELECT l.property_id, $2, $3, l.transaction_type, l.price_usd, l.price_period,
           'active', l.description_i18n, l.description_source_lang
    FROM listings l WHERE l.id = $1`, [seed.listing_id, other.id, other.agent_id]);
  return { propertyId: seed.property_id };
}
