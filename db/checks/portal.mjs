#!/usr/bin/env node
/**
 * Vérifie la collecte d'annonces de portail (§6.1, canal 4) — hors ligne.
 *
 * Ce contrôle ne touche à AUCUN portail réel : il injecte des pages fabriquées
 * à la main, de la même forme que celles du portail. C'est délibéré à deux
 * titres — un contrôle ne doit pas dépendre d'un site tiers pour passer, et le
 * dépôt n'a pas à embarquer du contenu recopié d'un portail pour se tester.
 *
 * Ce qui est vérifié tient en une phrase : on ne reprend que des faits, on ne
 * publie jamais un prix faux, et on préfère écarter une annonce que la ranger
 * au hasard.
 *
 *   node db/checks/portal.mjs
 */
import { collect, toRecord, toPhotos, fetchPhotos, fetchDetail, toFacts,
         parsePrice, parseArea, addressParts,
         SOURCES, PER_SQM, MAX_PHOTOS } from "../lib/portal.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

const source = SOURCES["realestate.com.kh"];

/** Annonce de portail fabriquée : la forme, pas le contenu. */
const raw = (over = {}) => ({
  id: 1001,
  url: "/rent/tonle-bassac/3-bed-condo-1001/",
  address: "Tonle Bassac, Chamkarmon, Phnom Penh",
  categoryName: "Condo",
  listingType: "rent",
  displayRent: "$1,800",
  displayPrice: "POA",
  imagesCount: 12,
  createdAt: "2026-08-01T09:00:00+07:00",
  addressLatitude: 11.55,
  addressLongitude: 104.93,
  specifications: { detail: [
    { type: "bedrooms", shortLabel: "3" },
    { type: "bathrooms", shortLabel: "2" },
    { type: "floor_area", shortLabel: "110m²" },
    { type: "floor_level", shortLabel: "8" },
  ] },
  ...over,
});

const pageHtml = (results) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${
    JSON.stringify({ props: { pageProps: { cacheData: { results: { data: { results } } } } } })
  }</script></body></html>`;

// ------------------------------------------------------------- Analyseurs
console.log("Analyse des valeurs");
check("un prix formaté est lu", parsePrice("$5,500") === 5500);
check("les abréviations d'échelle sont lues", parsePrice("$1.2M") === 1200000);
check("« POA » n'est pas un prix", parsePrice("POA") === null && parsePrice("") === null);
check("un prix au m² est reconnu comme tel",
      PER_SQM.test("$740/m²") && !PER_SQM.test("$740"));
check("une surface est lue", parseArea("300m²") === 300 && parseArea(undefined) === null);
check("une surface implausible est absente plutôt que fausse",
      parseArea("1m²") === null && parseArea("0") === null && parseArea("12m²") === 12,
      `${parseArea("1m²")} ${parseArea("12m²")}`);
check("une adresse est découpée du plus précis au plus large",
      addressParts("  , Tonle Bassac, Chamkarmon, Phnom Penh")
        .join("|") === "Tonle Bassac|Chamkarmon|Phnom Penh");

// ------------------------------------------------------------ Traduction
console.log("Traduction en faits");
const condo = toRecord(raw(), source);
check("un condo à louer est repris", condo?.propertyType === "condo"
      && condo.transaction === "rent" && condo.priceUsd === 1800
      && condo.bedrooms === 3 && condo.indoorAreaSqm === 110 && condo.floor === 8,
      JSON.stringify(condo));
check("l'URL d'origine est conservée",
      condo?.sourceUrl === `${source.origin}/rent/tonle-bassac/3-bed-condo-1001/`);

// La règle qui compte : rien du travail éditorial ni du carnet d'adresses du
// portail n'entre en base. Les photos font exception, mais par leur ADRESSE :
// c'est un lien vers le fichier de la source, jamais une copie ni son
// habillage éditorial.
const forbidden = ["headline", "title", "description", "email",
                   "phone", "owner", "agent", "office"];
const keys = Object.keys(condo ?? {}).map((k) => k.toLowerCase());
check("aucun champ de texte libre ni de contact n'est repris",
      forbidden.every((f) => !keys.some((k) => k.includes(f))), keys.join(", "));

check("les catégories du portail tombent sur les types du schéma",
      toRecord(raw({ categoryName: "Penthouse" }), source).propertyType === "condo"
      && toRecord(raw({ categoryName: "Twin Villa" }), source).propertyType === "villa"
      && toRecord(raw({ categoryName: "Link House" }), source).propertyType === "borey_house"
      && toRecord(raw({ categoryName: "Shophouse" }), source).propertyType === "flat_shophouse");

// ------------------------------------------------------- Ce qu'on écarte
console.log("Ce qui est écarté plutôt que deviné");
{
  const base = { id: 1, url: "/buy/x/condo-1/", categoryName: "Condo", listingType: "sale",
    displayPrice: "$120,000", addressLatitude: 11.55, addressLongitude: 104.92,
    specifications: { detail: [{ type: "land_area", shortLabel: "32136m²" }, { type: "bedrooms", shortLabel: "1" }] },
    images: [] };
  const condo = toRecord(base, { slug: "src", origin: "https://portail.example" });
  const villa = toRecord({ ...base, categoryName: "Villa" }, { slug: "src", origin: "https://portail.example" });
  check("un condo n'a pas de surface de terrain — celle du projet n'est pas reprise",
        condo !== null && condo.landAreaSqm === null, JSON.stringify(condo?.landAreaSqm));
  check("… mais une villa garde la sienne", villa?.landAreaSqm === 32136, JSON.stringify(villa?.landAreaSqm));
}
check("une catégorie inconnue est écartée",
      toRecord(raw({ categoryName: "Houseboat" }), source) === null);
check("un programme neuf n'est pas une unité à vendre",
      toRecord(raw({ categoryName: "Project" }), source) === null);
check("un prix non public est écarté",
      toRecord(raw({ displayRent: "POA" }), source) === null);
check("une annonce sans coordonnées est écartée (jamais de géocodage)",
      toRecord(raw({ addressLatitude: null, addressLongitude: null }), source) === null
      && toRecord(raw({ addressLatitude: 0, addressLongitude: 0 }), source) === null);
check("une coordonnée hors du Cambodge est une donnée cassée, pas un pin",
      toRecord(raw({ addressLatitude: 14.409, addressLongitude: 13.700 }), source) === null
      && toRecord(raw({ addressLatitude: 13.36, addressLongitude: 103.86 }), source) !== null);

// Le piège qui met un terrain de 2,8 hectares à 740 dollars en vitrine.
const perSqm = toRecord(raw({
  categoryName: "Land", listingType: "sale", displayPrice: "$740/m²",
  specifications: { detail: [{ type: "land_area", shortLabel: "1500m²" }] },
}), source);
check("un prix au m² est multiplié par la surface",
      perSqm?.priceUsd === 740 * 1500, JSON.stringify(perSqm?.priceUsd));
check("un prix au m² sans surface est écarté plutôt que publié faux",
      toRecord(raw({ categoryName: "Land", listingType: "sale",
                     displayPrice: "$740/m²", specifications: { detail: [] } }), source) === null);

// ---------------------------------------------------------------- Photos
console.log("Photos de l'annonce");
const gallery = [
  { url: "https://images.example.kh/listings/b.jpeg", width: 1050, height: 700, sortOrder: 1,
    alt: "Texte publié par la source", thumbnails: [
      { url: "https://images.example.kh/__sized__/b-400x300.jpeg", width: 400, height: 300 },
      { url: "https://images.example.kh/__sized__/b-1040x780.jpeg", width: 1040, height: 780 }] },
  { url: "https://images.example.kh/listings/a.jpeg", width: 1050, height: 700, sortOrder: 0,
    thumbnails: [] },
  { url: "/relatif/pas-une-url.jpeg", width: 10, height: 10, sortOrder: 2, thumbnails: [] },
  { url: "https://images.example.kh/listing-static-maps/c.png", type: "map",
    width: 512, height: 512, sortOrder: 3, thumbnails: [] },
];
const photos = toPhotos(gallery);
check("l'ordre de la source est respecté",
      photos.map((p) => /\/a\./.test(p.url) ? "a" : "b").join(",") === "a,b",
      photos.map((p) => p.url).join(" "));
check("la source retenue est la plus grande taille publiée, pas l'original",
      photos[1].url.endsWith("b-1040x780.jpeg"), photos[1].url);
check("sans vignette publiée, l'original fait office de source",
      photos[0].url.endsWith("listings/a.jpeg"), photos[0].url);
check("une adresse qui n'est pas une URL absolue est rejetée", photos.length === 2);
check("les vignettes de carte engendrées ne sont pas des photos du bien",
      photos.every((p) => !p.url.includes("listing-static-maps")));
check("le média porte l'adresse chez la source, pas une copie",
      photos.every((p) => p.url.startsWith("https://")));
check("les variantes sont décroissantes — le repli doit être la plus grande",
      photos[1].variants.map((v) => v.width).join(",") === "1040,400");
check("le texte alternatif de la source n'est pas repris",
      photos.every((p) => !("alt" in p)), JSON.stringify(Object.keys(photos[0])));
check("la galerie est plafonnée",
      toPhotos(Array.from({ length: 40 }, (_, i) => ({
        url: `https://images.example.kh/${i}.jpeg`, sortOrder: i, thumbnails: [] })))
        .length === MAX_PHOTOS);

const detailHtml = `<html><script id="__NEXT_DATA__" type="application/json">${
  JSON.stringify({ props: { pageProps: { cacheData: { listing: { data: {
    showCase: { images: gallery } } } } } } })}</script></html>`;
const fetched = await fetchPhotos("https://portail.example/annonce/1", {
  fetchImpl: () => Promise.resolve({ ok: true, status: 200,
                                     text: () => Promise.resolve(detailHtml) }) });
check("la galerie complète est lue sur la page de l'annonce", fetched?.length === 2);
check("une page illisible ne casse pas la passe",
      await fetchPhotos("https://portail.example/annonce/2", {
        fetchImpl: () => Promise.resolve({ ok: true, status: 200,
                                           text: () => Promise.resolve("<html></html>") }) }) === null
      && await fetchPhotos("https://portail.example/annonce/3", {
        fetchImpl: () => Promise.resolve({ ok: false, status: 404,
                                           text: () => Promise.resolve("") }) }) === null);

// ------------------------------------------------------- Faits de la page
console.log("Faits de la page d'annonce");
const features = [
  { headline: "Property Overview", items: [
    { label: "Property type: Condo" }, { label: "Title: Hard Title" },
    { label: "Agency: {link}" }, { label: "Property ID: 267028" }] },
  { headline: "Property Features", items: [
    { label: "Air Conditioning" }, { label: "Balcony" }, { label: "Fully Furnished" },
    { label: "Internet / Wifi" }, { label: "Pet Friendly" }] },
  { headline: "Security", items: [{ label: "Reception 24/7" }, { label: "Video Security" }] },
  { headline: "Amenities", items: [
    { label: "Backup Electricity / Generator" }, { label: "Car Parking" },
    { label: "Commercial area" }, { label: "Gym/Fitness Center" }, { label: "Lift / Elevator" },
    { label: "Non-Flooding" }, { label: "Swimming Pool" }] },
  { headline: "Views", items: [{ label: "Sea / Ocean Views" }] },
];
const facts = toFacts(features);
check("le régime de propriété est lu", facts.titleType === "hard", String(facts.titleType));
check("« Fully Furnished » vaut meublé", facts.furnished === true);
check("les équipements arrivent dans le vocabulaire des filtres, triés",
      facts.amenities.join(",") ===
        "aircon,balcony,cctv,elevator,generator,gym,parking,pet_friendly,pool,sea_view,security_24h,wifi",
      facts.amenities.join(","));
check("un libellé inconnu est ignoré, pas inventé",
      !facts.amenities.some((a) => /flood|commercial/.test(a)));
const partial = toFacts([{ headline: "Property Features", items: [{ label: "Partially Furnished" }] },
                         { headline: "Property Overview", items: [{ label: "Title: LMAP Title" }] }]);
check("« Partially Furnished » n'est pas meublé", partial.furnished === false);
check("un régime de propriété qu'on ne sait pas ranger reste inconnu", partial.titleType === null);
check("sans liste de faits, rien n'est affirmé",
      JSON.stringify(toFacts(undefined)) === JSON.stringify({ titleType: null, furnished: false, amenities: [] }));

const detail = await fetchDetail("https://portail.example/annonce/4", {
  fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
      cacheData: { listing: { data: { showCase: { images: gallery }, features } } } } } })}</script></html>`) }) });
check("la page livre photos et faits ensemble",
      detail?.photos.length === 2 && detail.facts.titleType === "hard" && detail.facts.amenities.includes("pool"));
check("une page sans galerie donne une galerie vide, pas un échec",
      (await fetchDetail("https://portail.example/annonce/5", {
        fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(
          `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
            cacheData: { listing: { data: { features } } } } } })}</script></html>`) }) }))?.photos.length === 0);

// ---------------------------------------------------------- Parcours des pages
console.log("Parcours des pages");
const visited = [];
const fakeFetch = (url) => {
  visited.push(url);
  const page = Number(new URL(url).searchParams.get("page") ?? 1);
  // Trois pages pleines, puis la liste s'arrête.
  const results = page <= 3
    ? Array.from({ length: 2 }, (_, i) => raw({ id: page * 100 + i }))
    : [];
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(pageHtml(results)) });
};

const collected = await collect({ portal: "realestate.com.kh", transaction: "rent",
                                  pages: 10, delayMs: 0, fetchImpl: fakeFetch });
check("la collecte s'arrête sur une page vide", visited.length === 4, visited.join(" "));
check("chaque annonce n'est reprise qu'une fois", collected.length === 6);
check("la première page n'est pas paginée", !visited[0].includes("page="));

const stopped = [];
const failing = (url) => {
  stopped.push(url);
  return Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("") });
};
const none = await collect({ portal: "realestate.com.kh", transaction: "sale",
                             pages: 5, delayMs: 0, fetchImpl: failing });
check("un refus du serveur arrête la collecte au lieu d'insister",
      stopped.length === 1 && none.length === 0);

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
