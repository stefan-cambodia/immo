/**
 * Rattachement des annonces collectées à leur programme immobilier.
 *
 * Le portail range les annonces d'un même immeuble neuf sous l'adresse du
 * programme ; `db/lib/portal.mjs` en tire un slug (depuis n'importe quelle
 * adresse d'annonce) et un nom (depuis la page). Ce module fait le reste :
 * retrouver l'immeuble, le créer s'il manque, y accrocher les biens.
 *
 * Trois règles, et chacune a coûté d'être posée :
 *
 * 1. LE RAPPROCHEMENT EST EXACT. Un slug égal, jamais ressemblant. La source
 *    distingue `urban-village-phase-1` de `urban-village-phase-2`,
 *    `the-peak-residences` de `the-peak`, `time-square-3` de
 *    `time-square-306` : ce sont des programmes ou des phases distincts, et
 *    un à-peu-près rangerait des annonces sous le mauvais projet — ce qui se
 *    voit immédiatement sur la fiche.
 *
 * 2. ON NE TOUCHE QU'AUX BIENS QUE LA COLLECTE A CRÉÉS (`geo_pin_by` en
 *    `portal:…`), et seulement s'ils n'ont pas déjà d'immeuble. Une annonce
 *    collectée qui s'est greffée sur un bien saisi par une agence n'a pas à
 *    réécrire sa fiche — c'est la règle que la passe `--photos` applique déjà
 *    aux faits.
 *
 * 3. LA PROVENANCE EST INSCRITE DANS LA DONNÉE. Un immeuble créé ici porte
 *    l'adresse de la page du programme dans `source_url`, ce qui permet à
 *    `import-portal.mjs --purge` de le retirer comme le reste.
 *
 * Ce que la collecte n'établit pas : l'état d'avancement du programme, ses
 * étages, son nombre d'unités, son année de livraison. Le premier compte plus
 * que les autres, parce qu'il s'affiche : laisser la valeur par défaut de la
 * colonne (`completed`) ferait annoncer « Achevé » sur le hub et sur la fiche,
 * sans rien pour l'appuyer, et précisément sur le point qu'un acheteur sur
 * plan vient vérifier. D'où `unknown` (migration 025). Un immeuble créé par la
 * collecte est une coquille juste mais pauvre, à enrichir à la main.
 */

/** Le motif d'adresse d'un programme, pour retrouver ses annonces. */
const listingsOfProject = `
  EXISTS (SELECT 1 FROM listings l
           WHERE l.property_id = p.id AND l.source = 'portal'
             AND l.source_url LIKE '%/new-developments/' || $1 || '/%')`;

/** L'immeuble portant ce slug — `null` s'il n'existe pas. Égalité exacte. */
export async function findByProjectSlug(db, slug) {
  if (!slug) return null;
  const { rows: [row] } = await db.query(
    `SELECT id, slug, name_i18n->>'en' AS name, source_url AS "sourceUrl"
       FROM buildings WHERE slug = $1`, [slug]);
  return row ?? null;
}

/**
 * Les biens collectés d'un programme qui n'ont pas encore d'immeuble.
 *
 * Sert aussi bien à décider s'il vaut la peine de créer l'immeuble qu'à savoir
 * ce qu'on y accrochera.
 */
export async function projectProperties(db, slug) {
  const { rows } = await db.query(
    `SELECT p.id FROM properties p
      WHERE p.building_id IS NULL AND p.geo_pin_by LIKE 'portal:%' AND ${listingsOfProject}`,
    [slug]);
  return rows.map((r) => r.id);
}

/**
 * Crée l'immeuble d'un programme à partir de ses propres unités.
 *
 * La localité est celle du plus grand nombre de ses biens, et le point est le
 * barycentre de leurs pins. Le principe n°2 interdit de géocoder une adresse
 * texte ; ici on ne géocode rien — on dérive une position de pins que des
 * agents ont posés, ce qui est la seule position dont on dispose et la seule
 * qu'on puisse défendre. Sans unité positionnée, rien n'est créé : un immeuble
 * sans point ne passerait pas le `NOT NULL` de la colonne, et n'aurait rien à
 * montrer sur une carte.
 */
export async function createFromProject(db, { slug, name, url }) {
  const { rows: [row] } = await db.query(`
    INSERT INTO buildings(slug, name_i18n, location_id, geo_point, status, source_url)
    SELECT $1,
           -- Un nom propre ne se traduit pas : le même dans les quatre langues.
           jsonb_build_object('fr', $2::text, 'en', $2::text,
                              'zh-Hans', $2::text, 'km', $2::text),
           mode() WITHIN GROUP (ORDER BY p.location_id),
           ST_SetSRID(ST_Centroid(ST_Collect(p.geo_point)), 4326),
           'unknown',
           $3
      FROM properties p
     WHERE p.building_id IS NULL AND p.geo_pin_by LIKE 'portal:%' AND ${listingsOfProject}
    HAVING count(*) > 0
    RETURNING id, slug`,
    [slug, name, url]);
  return row ?? null;
}

/**
 * Accroche à un immeuble les biens collectés de son programme.
 *
 * @returns {Promise<number>} nombre de biens rattachés
 */
export async function linkProject(db, { buildingId, slug }) {
  const { rowCount } = await db.query(`
    UPDATE properties p SET building_id = $2, updated_at = now()
     WHERE p.building_id IS NULL AND p.geo_pin_by LIKE 'portal:%' AND ${listingsOfProject}`,
    [slug, buildingId]);
  return rowCount;
}

/**
 * Les programmes que la base connaît par leurs annonces, avec ce qu'on en sait.
 *
 * `building` vaut l'immeuble déjà en base au même slug, ou `null` : c'est la
 * ligne de partage entre ce qui se rattache hors ligne et ce qui demande
 * d'ouvrir une page pour en connaître le nom.
 */
export async function knownProjects(db) {
  // `b.slug = g.slug` est qualifié des deux côtés : un `slug` nu dans la
  // sous-requête se lierait à la colonne de `buildings`, et la comparaison
  // serait toujours vraie.
  const { rows } = await db.query(`
    WITH src AS (
      SELECT split_part(l.source_url, '/', 5) AS slug, l.source_url AS url
        FROM listings l
       WHERE l.source = 'portal' AND l.source_url LIKE '%/new-developments/%'),
    grouped AS (
      SELECT src.slug, count(*)::int AS listings, min(src.url) AS sample_url
        FROM src WHERE src.slug <> '' GROUP BY src.slug)
    SELECT g.slug, g.listings, g.sample_url AS "sampleUrl",
           (SELECT b.id FROM buildings b WHERE b.slug = g.slug) AS "buildingId"
      FROM grouped g ORDER BY g.listings DESC, g.slug`);
  return rows;
}

/**
 * Retire les immeubles que la collecte a créés et que plus aucun bien n'occupe.
 *
 * C'est la contrepartie de la règle n°3, appelée par
 * `import-portal.mjs --purge` : sans elle, retirer les annonces et les biens
 * d'un portail laisserait derrière des pages de projet vides. Un immeuble qui
 * porte encore un bien saisi ailleurs reste — la collecte ne l'avait
 * qu'inauguré, il ne lui appartient pas.
 */
export async function purgeProjectBuildings(db) {
  const { rowCount } = await db.query(`
    DELETE FROM buildings b
     WHERE b.source_url IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.building_id = b.id)`);
  return rowCount;
}
