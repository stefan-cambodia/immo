// Vérifie la logique SQL de fusion de doublons dans une transaction annulée.
import pg from "pg";
const c = new pg.Client({ connectionString: "postgres://immo:immo@localhost:5433/cambodia_immo" });
await c.connect();
await c.query("BEGIN");

const { rows: [cand] } = await c.query(
  `SELECT id, property_a_id a, property_b_id b FROM dedup_candidates WHERE reviewed_at IS NULL LIMIT 1`);

const count = async (id) =>
  (await c.query(`SELECT count(*)::int n FROM listings WHERE property_id=$1`, [id])).rows[0].n;

console.log("avant :", { a: await count(cand.a), b: await count(cand.b) });

await c.query(
  `UPDATE listings SET property_id = $1 WHERE property_id = $2
     AND NOT EXISTS (SELECT 1 FROM listings k WHERE k.property_id = $1
       AND k.agency_id = listings.agency_id
       AND k.transaction_type = listings.transaction_type AND k.status = 'active')`,
  [cand.a, cand.b]);
await c.query(`DELETE FROM properties WHERE id = $1`, [cand.b]);
await c.query(`UPDATE dedup_candidates SET reviewed_at = now(), decision='merged' WHERE id=$1`, [cand.id]);

const bGone = (await c.query(`SELECT count(*)::int n FROM properties WHERE id=$1`, [cand.b])).rows[0].n === 0;
console.log("après :", { a: await count(cand.a), doublonSupprimé: bGone });

// Contrainte : un bien sans pin est impossible.
try {
  await c.query(`INSERT INTO properties(reference, property_type, location_id, geo_point, dedup_signature)
                 VALUES ('TEST-NOPIN','condo',(SELECT id FROM locations LIMIT 1), NULL, 'x')`);
  console.log("pin obligatoire : NON RESPECTÉ");
} catch (e) {
  console.log("pin obligatoire : respecté —", e.message.split("\n")[0]);
}

await c.query("ROLLBACK");
await c.end();
