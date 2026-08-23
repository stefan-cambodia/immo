"use server";

import { redirect } from "next/navigation";
import { AlertError, createAlert } from "@/lib/alerts";
import { DEFAULT_LOCALE, getTranslator, isLocale } from "@/lib/i18n";
import { filtersToQueryString, parseFilters } from "@/lib/search";

const FILTER_KEYS = ["txn", "area", "building", "type", "pmin", "pmax", "beds", "baths",
  "area_min", "floor", "title", "foreign", "furnished", "amenity", "bbox", "polygon"];

/**
 * Création d'une alerte. Formulaire sans JavaScript, retour par l'URL, comme
 * le reste du site : les critères voyagent en champs cachés sous la même forme
 * que dans l'URL de recherche, et sont relus par `parseFilters` — aucune
 * seconde grammaire de filtres.
 */
export async function subscribeAction(form: FormData) {
  const localeRaw = String(form.get("locale") ?? DEFAULT_LOCALE);
  const locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;

  const sp: Record<string, string | string[]> = {};
  for (const key of FILTER_KEYS) {
    const all = form.getAll(key).map(String).filter(Boolean);
    if (all.length === 1) sp[key] = all[0];
    else if (all.length > 1) sp[key] = all;
  }
  const filters = parseFilters(sp);
  const qs = filtersToQueryString(filters);
  const back = (params: Record<string, string>) => {
    const p = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(params)) p.set(k, v);
    return `/${locale}/alerts?${p.toString()}`;
  };

  // Champ piège : un formulaire rempli par un robot le renseigne, un humain
  // ne le voit pas. On répond comme si tout allait bien.
  if (String(form.get("website") ?? "")) redirect(back({ done: "email", email: "" }));

  const channel = String(form.get("channel") ?? "email");
  const email = String(form.get("email") ?? "");
  const frequency = String(form.get("frequency") ?? "daily");
  const t = await getTranslator(locale);

  let result;
  try {
    result = await createAlert({ channel, email, frequency, filters, t });
  } catch (err) {
    const code = err instanceof AlertError ? err.code.split(":")[0] : "generic";
    console.error("[alerts] inscription refusée :", err instanceof Error ? err.message : err);
    redirect(back({ error: code, channel, frequency }));
  }

  redirect(result.channel === "email"
    ? back({ done: "email", email: email.trim().toLowerCase() })
    : back({ done: "telegram", link: result.deepLink ?? "" }));
}
