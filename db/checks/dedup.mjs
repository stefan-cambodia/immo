#!/usr/bin/env node
/**
 * Vérifie les règles du moteur de déduplication (§6.2) — hors ligne.
 *
 * Le moteur décide si un humain sera dérangé, et si deux annonces seront
 * fusionnées. Ses règles se testent donc unitairement, sur des paires
 * fabriquées, sans dépendre de l'état d'une base : c'est le seul moyen de
 * couvrir les cas limites — l'accord structurel nu, le désaccord franc, la
 * corroboration photographique — qui ne se rencontrent pas à volonté dans un
 * jeu de données.
 *
 * Ce que ce contrôle protège, en une phrase : **une correspondance
 * structurelle sans immeuble et sans photo ne doit pas peupler la file**, et
 * un canal qui n'apporte pas de photos ne doit pas pour autant devenir aveugle.
 *
 *   node db/checks/dedup.mjs
 */
import { findDuplicates, scoreMatch, QUEUE_THRESHOLD } from "../lib/dedup.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

/**
 * Un condo de 58 m², 1 chambre, 12e étage, dans un immeuble non identifié.
 * Les cas « accord structurel nu » laissent la surface absente du candidat :
 * ni accord ni désaccord, seuls l'étage et les chambres parlent.
 */
const input = (over = {}) => ({
  buildingId: null, locationId: "loc-1", propertyType: "condo",
  floor: 12, bedrooms: 1, indoorAreaSqm: 58, landAreaSqm: null,
  agencyId: "agence-1", ...over,
});

const row = (over = {}) => ({
  id: "bien-2", reference: "XX-2", building_id: null, location_id: "loc-1",
  property_type: "condo", floor: 12, bedrooms: 1,
  indoor_area_sqm: 58, land_area_sqm: null,
  agency_ids: [], photo_distance: null, ...over,
});

// ------------------------------------------------------------------- Notes
console.log("Notation d'une paire");

const nu = scoreMatch(input(), row({ indoor_area_sqm: null }));
check("étage + chambres seuls valent exactement le seuil",
      Math.abs(nu.score - QUEUE_THRESHOLD) < 1e-9, String(nu.score));
check("… et ne sont pas corroborés", nu.corroborated === false);

const identique = scoreMatch(input(), row());
check("l'accord de surface à 2 % s'ajoute",
      Math.abs(identique.score - 0.55) < 1e-9, String(identique.score));

// Le cas trouvé sur les annonces collectées : une villa de 184 m² appariée à
// une de 684 m² parce que rien ne pesait contre.
const incompatible = scoreMatch(
  input({ indoorAreaSqm: 184 }), row({ indoor_area_sqm: 684 }));
check("un désaccord franc de surface fait baisser la note",
      incompatible.score < QUEUE_THRESHOLD, String(incompatible.score));
check("… et il est dit dans les motifs",
      incompatible.reasons.some((r) => r.startsWith("surface incompatible")),
      incompatible.reasons.join(", "));

check("la note ne sort jamais de [0, 1]",
      [scoreMatch(input({ indoorAreaSqm: 10, floor: null, bedrooms: 9 }),
                  row({ indoor_area_sqm: 900 })).score,
       scoreMatch(input({ buildingId: "imm-1" }),
                  row({ building_id: "imm-1", photo_distance: 0 })).score]
        .every((s) => s >= 0 && s <= 1));

console.log("Corroboration");
check("une photo identique corrobore",
      scoreMatch(input(), row({ photo_distance: 2 })).corroborated === true);
check("une photo ressemblante corrobore aussi",
      scoreMatch(input(), row({ photo_distance: 9 })).corroborated === true);
check("une photo sans rapport ne corrobore pas",
      scoreMatch(input(), row({ photo_distance: 22 })).corroborated === false);
check("un immeuble identifié corrobore sans photo",
      scoreMatch(input({ buildingId: "imm-1" }),
                 row({ building_id: "imm-1" })).corroborated === true);

// -------------------------------------------------------------- Décisions
console.log("Décision de l'entonnoir");

/** Base en trompe-l'œil : `findDuplicates` ne fait qu'une requête. */
const fakeDb = (rows) => ({ query: async () => ({ rows }) });

const structuralOnly = await findDuplicates(fakeDb([row({ indoor_area_sqm: null })]),
  { ...input(), phashes: ["0".repeat(64)] });
check("photos connues + accord structurel nu → aucun dérangement",
      structuralOnly.decision === "new", JSON.stringify(structuralOnly.reasons));
check("… et le motif dit pourquoi",
      structuralOnly.reasons.includes("accord structurel sans corroboration"),
      structuralOnly.reasons.join(", "));

const withPhoto = await findDuplicates(fakeDb([row({ indoor_area_sqm: null, photo_distance: 3 })]),
  { ...input(), phashes: ["0".repeat(64)] });
check("photos connues + photo identique → file de validation",
      withPhoto.decision === "review", withPhoto.decision);

// Le garde-fou : un canal sans empreintes ne devient pas aveugle. Mieux vaut
// une file trop large qu'un doublon publié sans que personne ne l'ait vu.
const noPhashes = await findDuplicates(fakeDb([row({ indoor_area_sqm: null })]),
  { ...input(), phashes: [] });
check("photos inconnues → comportement d'origine conservé",
      noPhashes.decision === "review", noPhashes.decision);

const strong = await findDuplicates(
  fakeDb([row({ building_id: "imm-1" })]),
  { ...input({ buildingId: "imm-1" }), phashes: ["0".repeat(64)] });
check("même unité d'un immeuble identifié → fusion",
      strong.decision === "merge", strong.decision);

const ownStrong = await findDuplicates(
  fakeDb([row({ building_id: "imm-1", agency_ids: ["agence-1"] })]),
  { ...input({ buildingId: "imm-1" }), phashes: ["0".repeat(64)] });
check("… sauf face à sa propre annonce, qui passe par un humain",
      ownStrong.decision === "review", ownStrong.decision);

const nothing = await findDuplicates(fakeDb([]), { ...input(), phashes: [] });
check("aucun bien comparable → création", nothing.decision === "new");

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
