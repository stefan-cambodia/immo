// Jeu de données de démarrage : ~500 biens réalistes sur Phnom Penh,
// Siem Reap et Sihanoukville, avec annonces multiples par bien pour
// démontrer la proposition de valeur « un bien = une fiche » (§1.3).
import pg from "pg";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { locations } from "./locations.mjs";

const scrypt = promisify(scryptCb);

// Même format que src/lib/auth.ts : scrypt$<sel hex>$<clé hex>.
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

const url = process.env.DATABASE_URL ?? "postgres://immo:immo@localhost:5433/cambodia_immo";
const db = new pg.Client({ connectionString: url });
await db.connect();

// PRNG déterministe : un seed rejoué donne exactement la même base.
let _s = 0x9e3779b9;
const rnd = () => (((_s = (_s + 0x6d2b79f5) | 0), (() => {
  let t = _s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
})()));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const chance = (p) => rnd() < p;
const jitter = (v, d) => v + (rnd() - 0.5) * d;

console.log("Nettoyage des tables de données…");
await db.query(`TRUNCATE leads, price_history, media, listings, properties, buildings,
  agents, agencies, developers, locations, search_misses, dedup_candidates,
  sessions, users, login_attempts, submissions, property_views RESTART IDENTITY CASCADE`);
// Le journal d'audit est en ajout seul : le déclencheur refuse un DELETE, et
// TRUNCATE le contournerait silencieusement. La table est vidée explicitement,
// pour que la remise à zéro d'un environnement de développement reste un geste
// conscient.
await db.query(`TRUNCATE audit_log RESTART IDENTITY`);

// ------------------------------------------------------------------ Locations
const locId = new Map();
for (const [slug, level, parent, names, aliases, [lng, lat]] of locations) {
  const { rows } = await db.query(
    `INSERT INTO locations(parent_id, level, slug, name_i18n, aliases, geo_center)
     VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6,$7),4326)) RETURNING id`,
    [parent ? locId.get(parent) : null, level, slug, names, aliases, lng, lat]
  );
  locId.set(slug, rows[0].id);
}
console.log(`  ${locId.size} localités, ${locations.reduce((a, l) => a + l[4].length, 0)} alias`);

// ------------------------------------------------------------------ Promoteurs
const developers = [
  ["Peng Huoth Group", "KH"], ["Chip Mong Land", "KH"], ["Prince Real Estate", "CN"],
  ["Overseas Cambodia Investment", "KH"], ["Urban Living Solutions", "SG"],
  ["Creed Group", "JP"], ["Borey Vimean Phnom Penh", "KH"], ["Canopy Sands", "CN"],
];
const devId = new Map();
for (const [name, country] of developers) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const { rows } = await db.query(
    `INSERT INTO developers(name, slug, country) VALUES ($1,$2,$3) RETURNING id`, [name, slug, country]);
  devId.set(name, rows[0].id);
}

// ------------------------------------------------------------------ Immeubles / boreys
const buildingSpecs = [
  // [nom en, nom zh, nom km, quartier, promoteur, étages, unités, année, statut]
  ["The Bridge", "大桥公寓", "ស្ពានរស់នៅ", "tonle-bassac", "Overseas Cambodia Investment", 45, 762, 2019, "completed"],
  ["Casa By Meridian", "卡萨公寓", "កាសា បាយ មេរីឌៀន", "tonle-bassac", "Overseas Cambodia Investment", 38, 570, 2020, "completed"],
  ["Embassy Central", "使馆中心", "អេមបាស៊ី សិនត្រល់", "bkk1", "Urban Living Solutions", 27, 199, 2021, "completed"],
  ["Embassy Residences", "使馆公馆", "អេមបាស៊ី រេស៊ីដិន", "tonle-bassac", "Urban Living Solutions", 24, 184, 2019, "completed"],
  ["The Peak", "顶峰", "ដឺ ភីក", "tonle-bassac", "Urban Living Solutions", 55, 1034, 2022, "completed"],
  ["Olympia City", "奥林匹亚城", "អូឡាំពិញ ស៊ីធី", "veal-vong", "Chip Mong Land", 40, 1600, 2018, "completed"],
  ["De Castle Royal", "皇家城堡", "ដឺ ខាសល រ៉ូយ៉ាល់", "bkk1", "Creed Group", 32, 320, 2015, "completed"],
  ["Morgan Tower", "摩根大厦", "ម័រហ្គេន ថៅវើរ", "koh-pich", "Prince Real Estate", 42, 780, 2023, "completed"],
  ["Prince Huan Yu Center", "太子寰宇中心", "ព្រីនស៍ ហ័នយូ", "chak-angre", "Prince Real Estate", 39, 640, 2022, "completed"],
  ["The Gateway", "门户", "ដឺ ហ្គេតវេ", "boeung-kak", "Creed Group", 39, 483, 2018, "completed"],
  ["Odom Tower", "奥丹大厦", "ឧត្តម ថៅវើរ", "bkk1", "Urban Living Solutions", 39, 250, 2024, "under_construction"],
  ["Urban Village", "都市村", "អឺបិន វីឡេជ", "chak-angre", "Urban Living Solutions", 22, 598, 2021, "completed"],
  ["D.I. Riviera", "钻石里维埃拉", "ឌី.អាយ រីវីអេរ៉ា", "koh-pich", "Prince Real Estate", 33, 462, 2020, "completed"],
  ["Skyline Residence", "天际公寓", "ស្កាយឡាញ", "phnom-penh-thmey", "Chip Mong Land", 28, 410, 2021, "completed"],
  ["Time Square 306", "时代广场306", "ថាមស្គ័រ ៣០៦", "teuk-thla", "Chip Mong Land", 26, 380, 2020, "completed"],
  ["Borey Peng Huoth Grand Star", "彭虎明星花园", "បុរី ប៉េងហួត", "chbar-ampov", "Peng Huoth Group", 3, 1200, 2019, "completed"],
  ["Borey Chip Mong 598", "祈梦598", "បុរី ជិបម៉ុង ៥៩៨", "pou-senchey", "Chip Mong Land", 3, 598, 2020, "completed"],
  ["Borey Vimean Phnom Penh", "金边宫苑", "បុរីវិមានភ្នំពេញ", "sen-sok", "Borey Vimean Phnom Penh", 3, 900, 2017, "completed"],
  ["Borey Orkide Villa", "兰花别墅区", "បុរីអូក្កីដេ", "prek-pnov", "Peng Huoth Group", 3, 740, 2018, "completed"],
  ["Rose Apple Square", "玫瑰广场", "រ៉ូស អាបផល", "svay-dangkum", "Creed Group", 12, 220, 2020, "completed"],
  ["Blue Bay Sihanoukville", "蓝湾", "ប៊្លូបេ", "independence-beach", "Canopy Sands", 38, 900, 2021, "completed"],
  ["Bay of Lights", "光之湾", "ប៊េ អហ្វ ឡាយត៍", "otres", "Canopy Sands", 30, 650, 2025, "under_construction"],
];
const buildings = [];
for (const [en, zh, km, hood, dev, floors, units, year, status] of buildingSpecs) {
  const slug = en.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const [lng0, lat0] = locations.find((l) => l[0] === hood)[5];
  const amenities = ["pool", "gym", "parking", "elevator", "security_24h", "generator"]
    .filter(() => chance(0.8));
  const { rows } = await db.query(
    `INSERT INTO buildings(slug, name_i18n, developer_id, location_id, geo_point,
       total_floors, total_units, completion_year, status, amenities)
     VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326), $7,$8,$9,$10,$11) RETURNING id`,
    [slug, { fr: en, en, zh, km }, devId.get(dev), locId.get(hood),
     jitter(lng0, 0.012), jitter(lat0, 0.012), floors, units, year, status, amenities]
  );
  buildings.push({ id: rows[0].id, slug, name: en, hood, floors, isBorey: en.startsWith("Borey") });
}
console.log(`  ${buildings.length} immeubles et boreys`);

// ------------------------------------------------------------------ Agences et agents
const agencySpecs = [
  ["IPS Cambodia", "verified", "premium", 500], ["Century 21 Mekong", "verified", "premium", 400],
  ["Keller Williams Cambodia", "verified", "standard", 200], ["Khmer Home Realty", "verified", "standard", 150],
  ["Angkor Estates", "documents_received", "standard", 120], ["Bassac Property", "verified", "standard", 100],
  ["Sihanoukville Land Co.", "unverified", "free", 20], ["Realestate.com.kh Partners", "verified", "premium", 300],
  ["Phnom Penh Property Hub", "unverified", "free", 20], ["Golden Dragon Realty 金龙地产", "documents_received", "standard", 90],
  ["Mekong Living", "verified", "standard", 110], ["Lucky Home Cambodia", "unverified", "free", 20],
];
const firstNames = ["Sophea", "Dara", "Chanthou", "Vichea", "Sokha", "Rithy", "Bopha", "Kunthea",
  "Marc", "Julien", "Emma", "Wei", "Li", "Zhang", "Sreymom", "Piseth", "Nary", "Vannak"];
const lastNames = ["Chan", "Sok", "Meas", "Keo", "Long", "Ouk", "Sam", "Nguon", "Dubois", "Martin", "Wang", "Chen"];
const agencies = [];
for (const [name, verif, tier, quota] of agencySpecs) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const { rows } = await db.query(
    `INSERT INTO agencies(slug, name, verification_status, subscription_tier, listing_quota)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [slug, name, verif, tier, quota]);
  const agencyId = rows[0].id;
  const agents = [];
  for (let i = 0; i < int(2, 4); i++) {
    const person = `${pick(firstNames)} ${pick(lastNames)}`;
    const langs = ["en", ...(chance(0.5) ? ["km"] : []), ...(chance(0.3) ? ["fr"] : []), ...(chance(0.25) ? ["zh"] : [])];
    const { rows: ar } = await db.query(
      `INSERT INTO agents(agency_id, name, phone, telegram, wechat, spoken_langs, telegram_chat_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [agencyId, person, `+855 ${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`,
       `@${person.split(" ")[0].toLowerCase()}${int(10, 99)}`,
       chance(0.3) ? `wx_${person.split(" ")[0].toLowerCase()}` : null,
       [...new Set(langs)], int(100000000, 999999999)]);
    agents.push(ar[0].id);
  }
  agencies.push({ id: agencyId, name, slug, tier, agents });
}
// Quota de mises en avant : la valeur effective suit le palier (013).
await db.query(
  `UPDATE agencies a SET featured_quota = p.featured_slots
   FROM plans p WHERE p.tier = a.subscription_tier`);
console.log(`  ${agencies.length} agences, ${agencies.reduce((a, x) => a + x.agents.length, 0)} agents`);

// -------------------------------------------------------------- Factures (§8)
// Deux mois de facturation pour les paliers payants : le mois précédent réglé
// (sauf un retardataire, pour que la file « en attente de règlement » et le
// chiffre « en retard » aient quelque chose à montrer), le mois courant émis.
let invoiceCount = 0;
let straggler = true;
for (const agency of agencies.filter((a) => a.tier !== "free")) {
  const { rows: [prev] } = await db.query(
    `INSERT INTO invoices(agency_id, agency_name, tier, period_start, period_end,
                          amount_usd, due_at, issued_at)
     SELECT a.id, a.name, a.subscription_tier,
            (date_trunc('month', now()) - interval '1 month')::date,
            date_trunc('month', now())::date,
            p.price_usd_month,
            date_trunc('month', now()) - interval '1 month' + interval '14 days',
            date_trunc('month', now()) - interval '1 month'
     FROM agencies a JOIN plans p ON p.tier = a.subscription_tier
     WHERE a.id = $1 RETURNING id`, [agency.id]);
  if (straggler) {
    straggler = false; // le premier reste impayé : il est en retard
  } else {
    await db.query(
      `UPDATE invoices SET status = 'paid', paid_at = due_at - interval '3 days',
              paid_note = 'ABA ' || lpad((random() * 1e9)::bigint::text, 9, '0')
       WHERE id = $1`, [prev.id]);
  }
  await db.query(
    `INSERT INTO invoices(agency_id, agency_name, tier, period_start, period_end,
                          amount_usd, due_at)
     SELECT a.id, a.name, a.subscription_tier,
            date_trunc('month', now())::date,
            (date_trunc('month', now()) + interval '1 month')::date,
            p.price_usd_month, now() + interval '14 days'
     FROM agencies a JOIN plans p ON p.tier = a.subscription_tier
     WHERE a.id = $1`, [agency.id]);
  invoiceCount += 2;
}
console.log(`  ${invoiceCount} factures`);

// ------------------------------------------------------------ Comptes back-office
// Mots de passe de développement, volontairement lisibles et affichés en fin de
// seed. Ils n'ont pas vocation à survivre au-delà de l'environnement local.
const DEV_PASSWORD = "cambodia-dev";
const accounts = [];

const adminHash = await hashPassword(DEV_PASSWORD);
await db.query(
  `INSERT INTO users(email, password_hash, role, name) VALUES ($1, $2, 'admin', $3)`,
  ["admin@khmerestate.kh", adminHash, "Équipe modération"]);
accounts.push(["admin@khmerestate.kh", "admin", "—"]);

for (const agency of agencies.slice(0, 4)) {
  const email = `${agency.slug.split("-")[0]}@khmerestate.kh`;
  await db.query(
    `INSERT INTO users(email, password_hash, role, agency_id, name)
     VALUES ($1, $2, 'agency', $3, $4)`,
    [email, await hashPassword(DEV_PASSWORD), agency.id, `${agency.name} — back-office`]);
  accounts.push([email, "agency", agency.name]);
}
console.log(`  ${accounts.length} comptes back-office`);

// ------------------------------------------------------------------ Biens
// Empreintes perceptuelles du jeu de démonstration. Les vraies sont calculées
// par src/lib/phash.ts à l'ingestion ; ici on en simule la forme — 64 bits — et
// surtout leur voisinage, puisque c'est la distance qui est intéressante.
const randomPhash = () =>
  Array.from({ length: 64 }, () => (rnd() < 0.5 ? "0" : "1")).join("");

const flipBits = (bits, count) => {
  const out = bits.split("");
  for (let i = 0; i < count; i++) {
    const at = int(0, 63);
    out[at] = out[at] === "0" ? "1" : "0";
  }
  return out.join("");
};

const stolenPool = [];

const AMENITIES = ["pool", "gym", "parking", "elevator", "security_24h", "generator", "balcony",
  "river_view", "sea_view", "garden", "playground", "cctv", "wifi", "pet_friendly", "aircon"];

// Répartition géographique : Phnom Penh domine, comme le marché réel.
const hoodWeights = [
  ["bkk1", 34], ["bkk2", 16], ["bkk3", 18], ["tonle-bassac", 30], ["koh-pich", 22],
  ["tuol-tumpung", 26], ["boeung-trabek", 14], ["tuol-svay-prey", 12], ["chey-chumneas", 14],
  ["phsar-thmei", 10], ["wat-phnom", 10], ["boeung-raing", 8], ["veal-vong", 14], ["monourom", 8],
  ["boeung-salang", 12], ["phsar-depo", 10], ["boeung-kak", 12], ["teuk-thla", 18],
  ["phnom-penh-thmey", 20], ["chrang-chamres", 8], ["chroy-changvar-village", 16],
  ["stueng-mean-chey", 12], ["chak-angre", 14],
  ["svay-dangkum", 16], ["sala-kamreuk", 12], ["slor-kram", 8], ["kouk-chak", 6],
  ["sangkat-buon", 12], ["otres", 10], ["ochheuteal", 10], ["victory-hill", 8], ["independence-beach", 12],
  ["krong-kampot", 8], ["krong-battambang", 6], ["krong-kep", 4], ["takhmao", 8],
];
const hoodPool = hoodWeights.flatMap(([slug, w]) => Array(w).fill(slug));

const TYPE_POOL = [
  ...Array(38).fill("condo"), ...Array(14).fill("borey_house"), ...Array(12).fill("villa"),
  ...Array(15).fill("flat_shophouse"), ...Array(8).fill("land"), ...Array(7).fill("commercial"),
  ...Array(3).fill("warehouse"), ...Array(3).fill("whole_building"),
];

// Prix de référence au m² (USD), par quartier — ordres de grandeur du marché.
const sqmPrice = {
  "bkk1": 2600, "bkk2": 2100, "bkk3": 2000, "tonle-bassac": 2500, "koh-pich": 2800,
  "tuol-tumpung": 1800, "boeung-trabek": 1600, "tuol-svay-prey": 1700, "chey-chumneas": 2200,
  "phsar-thmei": 1900, "wat-phnom": 2000, "boeung-raing": 1800, "veal-vong": 1500, "monourom": 1600,
  "boeung-salang": 1300, "phsar-depo": 1400, "boeung-kak": 1500, "teuk-thla": 1200,
  "phnom-penh-thmey": 1250, "chrang-chamres": 900, "chroy-changvar-village": 1450,
  "stueng-mean-chey": 950, "chak-angre": 1100,
  "svay-dangkum": 1100, "sala-kamreuk": 1000, "slor-kram": 850, "kouk-chak": 800,
  "sangkat-buon": 1150, "otres": 1000, "ochheuteal": 1250, "victory-hill": 900, "independence-beach": 1500,
  "krong-kampot": 800, "krong-battambang": 650, "krong-kep": 750, "takhmao": 700,
};

const TYPE_LABEL = {
  condo: { fr: "Appartement", en: "Condo", zh: "公寓", km: "ខុនដូ" },
  borey_house: { fr: "Maison en borey", en: "Borey house", zh: "别墅区住宅", km: "ផ្ទះក្នុងបុរី" },
  villa: { fr: "Villa", en: "Villa", zh: "别墅", km: "វីឡា" },
  flat_shophouse: { fr: "Flat / shophouse", en: "Flat / shophouse", zh: "排屋", km: "ផ្ទះល្វែង" },
  land: { fr: "Terrain", en: "Land", zh: "土地", km: "ដីធ្លី" },
  commercial: { fr: "Local commercial", en: "Commercial space", zh: "商铺", km: "អគារពាណិជ្ជកម្ម" },
  warehouse: { fr: "Entrepôt", en: "Warehouse", zh: "仓库", km: "ឃ្លាំង" },
  whole_building: { fr: "Immeuble entier", en: "Whole building", zh: "整栋楼", km: "អគារទាំងមូល" },
};

// §4.1 : la description est générée depuis les champs structurés, dans les
// quatre langues. Le contenu libre est réduit au minimum, donc le coût de
// traduction aussi.
function describe(p, hoodNames, txn) {
  const t = TYPE_LABEL[p.property_type];
  const bd = p.bedrooms, ar = p.indoor_area_sqm ?? p.land_area_sqm;
  const verb = { sale: { fr: "à vendre", en: "for sale", zh: "出售", km: "សម្រាប់លក់" },
                 rent: { fr: "à louer", en: "for rent", zh: "出租", km: "សម្រាប់ជួល" } }[txn];
  return {
    fr: `${t.fr} ${verb.fr} à ${hoodNames.fr}${bd ? `, ${bd} chambre${bd > 1 ? "s" : ""}` : ""}${ar ? `, ${ar} m²` : ""}.${p.furnished ? " Entièrement meublé." : ""}${p.floor ? ` Étage ${p.floor}.` : ""}`,
    en: `${t.en} ${verb.en} in ${hoodNames.en}${bd ? `, ${bd} bedroom${bd > 1 ? "s" : ""}` : ""}${ar ? `, ${ar} sqm` : ""}.${p.furnished ? " Fully furnished." : ""}${p.floor ? ` Floor ${p.floor}.` : ""}`,
    zh: `${hoodNames.zh}${t.zh}${verb.zh}${bd ? `，${bd}房` : ""}${ar ? `，${ar}平方米` : ""}。${p.furnished ? "全装修家具齐全。" : ""}${p.floor ? `${p.floor}层。` : ""}`,
    km: `${t.km}${verb.km}នៅ${hoodNames.km}${bd ? ` បន្ទប់គេង ${bd}` : ""}${ar ? ` ទំហំ ${ar} ម២` : ""}។${p.furnished ? " មានគ្រឿងសង្ហារិមគ្រប់គ្រាន់។" : ""}${p.floor ? ` ជាន់ទី ${p.floor}។` : ""}`,
  };
}

const TARGET = 500;
const hoodMeta = new Map(locations.map((l) => [l[0], { names: l[3], center: l[5] }]));
let propCount = 0, listingCount = 0, mediaCount = 0;
const now = Date.now();

for (let i = 0; i < TARGET; i++) {
  const hood = pick(hoodPool);
  const meta = hoodMeta.get(hood);
  let type = pick(TYPE_POOL);
  // Les terrains et entrepôts ne sont pas dans les quartiers centraux les plus chers.
  if ((type === "land" || type === "warehouse") && sqmPrice[hood] > 1800) type = "condo";

  const inBuilding = type === "condo" || type === "borey_house";
  const candidates = buildings.filter((b) => b.hood === hood && (type === "borey_house" ? b.isBorey : !b.isBorey));
  const building = inBuilding && candidates.length && chance(0.75) ? pick(candidates) : null;

  let floor = null, indoor = null, land = null, beds = 0, baths = 0, title = "unknown";
  switch (type) {
    case "condo":
      floor = building ? int(1, Math.max(2, building.floors)) : int(1, 22);
      beds = pick([0, 1, 1, 2, 2, 2, 3, 3, 4]);
      baths = Math.max(1, beds);
      indoor = beds === 0 ? int(32, 48) : beds * int(28, 42) + int(10, 25);
      // Le strata title est la norme sur le neuf en copropriété, pas partout.
      title = chance(0.72) ? "strata" : chance(0.5) ? "hard" : "unknown";
      break;
    case "borey_house":
      floor = 0; beds = int(3, 5); baths = int(2, 4);
      indoor = int(90, 220); land = int(60, 160);
      title = chance(0.65) ? "hard" : "soft";
      break;
    case "villa":
      floor = 0; beds = int(3, 7); baths = int(3, 6);
      indoor = int(180, 600); land = int(200, 900);
      title = chance(0.7) ? "hard" : "soft";
      break;
    case "flat_shophouse":
      floor = 0; beds = int(2, 6); baths = int(2, 5);
      indoor = int(80, 260); land = int(48, 120);
      title = chance(0.45) ? "hard" : "soft";
      break;
    case "land":
      indoor = null; land = int(120, 5000);
      title = chance(0.5) ? "hard" : "soft";
      break;
    case "commercial":
      floor = int(0, 3); indoor = int(60, 400);
      title = chance(0.5) ? "hard" : chance(0.5) ? "strata" : "soft";
      break;
    case "warehouse":
      floor = 0; indoor = int(500, 4000); land = int(800, 6000);
      title = chance(0.6) ? "hard" : "soft";
      break;
    case "whole_building":
      indoor = int(600, 3000); land = int(150, 500); beds = int(8, 30); baths = int(8, 30);
      title = chance(0.6) ? "hard" : "soft";
      break;
  }

  const furnished = ["condo", "villa", "borey_house"].includes(type) ? chance(0.55) : chance(0.15);
  const amenities = AMENITIES.filter(() => chance(type === "land" ? 0.03 : 0.28));
  const [lng0, lat0] = building
    ? [null, null]
    : meta.center;

  const prop = {
    property_type: type, floor, bedrooms: beds, bathrooms: baths,
    indoor_area_sqm: indoor, land_area_sqm: land, furnished,
  };

  const ref = `${hood.slice(0, 2).toUpperCase()}-${(i + 1000).toString(36).toUpperCase()}${int(100, 999)}`;
  const lng = building ? jitter(hoodMeta.get(building.hood).center[0], 0.004) : jitter(lng0, 0.018);
  const lat = building ? jitter(hoodMeta.get(building.hood).center[1], 0.004) : jitter(lat0, 0.018);
  // Chaque bien est saisi avec un pin posé manuellement (principe n°2) :
  // la traçabilité de la pose est conservée.
  const pinAt = new Date(now - int(1, 400) * 86400000);
  const verifiedAt = chance(0.78) ? new Date(now - int(0, 60) * 86400000) : null;

  const { rows: pr } = await db.query(
    `INSERT INTO properties(reference, building_id, property_type, villa_sub, location_id, geo_point,
       geo_pin_by, geo_pin_at, floor, unit_number, bedrooms, bathrooms, indoor_area_sqm,
       land_area_sqm, title_type, year_built, furnished, amenities, verified_at)
     VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6,$7),4326), $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id`,
    [ref, building?.id ?? null, type,
     type === "villa" ? pick(["twin", "link", "queen", "king"]) : null,
     locId.get(hood), lng, lat, "saisie interne (phase 1)", pinAt,
     floor, type === "condo" ? `${floor}${String(int(1, 12)).padStart(2, "0")}` : null,
     beds, baths, indoor, land, title,
     ["land"].includes(type) ? null : int(2008, 2024), furnished, amenities, verifiedAt]
  );
  const propertyId = pr[0].id;
  propCount++;

  // Photos : 4 à 9 visuels par bien, avec hash perceptuel simulé. Deux biens
  // distincts peuvent partager un hash — c'est exactement le signal que la
  // modération doit remonter (§6.3).
  const photoCount = type === "land" ? int(2, 4) : int(4, 9);
  for (let m = 0; m < photoCount; m++) {
    // Les photos repiquées ne sont pas des copies bit à bit : elles sont
    // recompressées, recadrées, filigranées. Le jeu de données reflète cela en
    // dérivant l'empreinte volée à quelques bits près, ce qui exerce vraiment
    // `phash_distance` au lieu d'une égalité stricte.
    let phash;
    if (chance(0.04) && stolenPool.length) {
      phash = flipBits(pick(stolenPool), int(0, 4));
    } else {
      phash = randomPhash();
      if (stolenPool.length < 12) stolenPool.push(phash);
    }
    await db.query(
      `INSERT INTO media(property_id, url, position, width, height, phash, variants)
       VALUES ($1,$2,$3,$4,$5,$6::bit(64),$7)`,
      [propertyId, `/api/photo/${propertyId.slice(0, 8)}-${m}`, m, 1600, 1067, phash,
       JSON.stringify([{ w: 400 }, { w: 800 }, { w: 1600 }])]);
    mediaCount++;
  }

  // ------------------------------------------------------------ Annonces
  // Le cœur du produit : plusieurs agences publient le même bien à des prix
  // différents. La distribution reflète le marché : une majorité de biens
  // multi-agences, quelques exclusivités de fait.
  const nAgencies = pick([1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6]);
  const chosen = [...agencies].sort(() => rnd() - 0.5).slice(0, nAgencies);
  const rentable = ["condo", "villa", "borey_house", "flat_shophouse", "commercial", "warehouse"].includes(type);
  const txn = rentable ? (chance(0.42) ? "rent" : "sale") : "sale";

  const base = sqmPrice[hood];
  const area = indoor ?? land ?? 100;
  let salePrice = type === "land"
    ? Math.round((land * base * 0.35) / 500) * 500
    : Math.round((area * base * (0.8 + rnd() * 0.5)) / 500) * 500;
  if (type === "whole_building") salePrice = Math.round(salePrice * 1.15 / 1000) * 1000;
  const rentPrice = Math.max(120, Math.round((salePrice * (0.0055 + rnd() * 0.0025)) / 10) * 10);

  for (const agency of chosen) {
    // Écart de prix entre agences : le fait de marché que la fiche unique rend visible.
    const spread = 1 + (rnd() - 0.42) * 0.14;
    const price = txn === "sale" ? Math.round(salePrice * spread / 500) * 500
                                 : Math.round(rentPrice * spread / 10) * 10;
    const daysAgo = int(0, 110);
    const created = new Date(now - daysAgo * 86400000);
    // Une partie des annonces n'a pas été reconfirmée depuis plus de 45 jours :
    // le cycle d'expiration (§6.3) doit être visible dans les données.
    const confirmDays = int(0, Math.min(daysAgo, 60));
    const confirmed = new Date(now - confirmDays * 86400000);
    const expires = new Date(confirmed.getTime() + 45 * 86400000);
    const status = expires.getTime() < now ? "expired" : "active";
    const srcLang = pick(["en", "en", "en", "km", "zh", "fr"]);
    // Une mise en avant est un achat à durée limitée (§8) : elle porte son
    // échéance, ici alignée sur celle de l'annonce.
    const isFeatured = agency.tier === "premium" && chance(0.12);

    const { rows: lr } = await db.query(
      `INSERT INTO listings(property_id, agency_id, agent_id, transaction_type, price_usd,
         price_period, negotiable, status, source, featured, featured_until,
         expires_at, last_confirmed_at,
         description_i18n, description_source_lang, translation_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [propertyId, agency.id, pick(agency.agents), txn, price,
       txn === "rent" ? "monthly" : "total", chance(0.7), status,
       pick(["backoffice", "backoffice", "backoffice", "csv", "xml_feed"]),
       isFeatured, isFeatured ? expires : null, expires, confirmed,
       // describe() produit déjà les quatre langues : ces annonces sont
       // dans l'état où le worker de traduction les aurait laissées.
       describe(prop, meta.names, txn), srcLang, 'machine', created]);

    // Historique de prix : les prix bougent, les acheteurs négocient (§6.3).
    if (chance(0.35)) {
      const older = Math.round(price * (1 + 0.03 + rnd() * 0.1) / 500) * 500;
      await db.query(
        `INSERT INTO price_history(listing_id, price_usd, recorded_at) VALUES ($1,$2,$3)`,
        [lr[0].id, older, new Date(created.getTime() - int(10, 120) * 86400000)]);
    }
    listingCount++;
  }
}

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

// Quelques recherches sans résultat, matière première de la table d'alias (§10).
for (const q of ["kompong som beach", "bkk one penthouse", "toul kok villa", "西港公寓",
                 "ភ្នំពេញថ្មី ដីលក់", "chruy changvar condo", "sen sok borey"]) {
  await db.query(`INSERT INTO search_misses(query, locale) VALUES ($1,$2)`,
    [q, pick(["fr", "en", "zh", "km"])]);
}

const { rows: stats } = await db.query(`
  SELECT (SELECT count(*) FROM properties) AS properties,
         (SELECT count(*) FROM listings WHERE status='active') AS active_listings,
         (SELECT count(*) FROM properties p WHERE p.foreign_eligible) AS foreign_ok,
         (SELECT count(*) FROM dedup_candidates WHERE reviewed_at IS NULL) AS dedup_queue,
         (SELECT round(avg(c)::numeric,2) FROM (
            SELECT count(DISTINCT agency_id) c FROM listings WHERE status='active' GROUP BY property_id) x
         ) AS avg_agencies_per_property`);

console.log(`  ${propCount} biens, ${listingCount} annonces, ${mediaCount} médias`);
console.table(stats[0]);

console.log(`\nComptes back-office (mot de passe : ${DEV_PASSWORD})`);
console.table(accounts.map(([email, role, agency]) => ({ email, role, agency })));
await db.end();
console.log("Seed terminé.");
