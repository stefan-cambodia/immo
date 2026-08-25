import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool, queryOne, withTransaction } from "@/lib/db";
import { actorFromUser, recordAudit } from "@/lib/audit";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n";
import { createMediaStore } from "../../../../../db/lib/media-store.mjs";
import { canManageProperty, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_UPLOAD, storePhotos,
         validatePhotos } from "../../../../../db/lib/media-upload.mjs";

/**
 * Envoi de photos vers un bien existant — formulaire multipart du
 * back-office, sans JavaScript.
 *
 * Route HTTP plutôt qu'action serveur : un point d'entrée à URL stable, que
 * le contrôle `db/checks/upload.mjs` exerce avec une vraie session et un
 * vrai multipart, et qui n'est pas soumis à la limite de corps des actions.
 * La garde est la même que pour une action : la session est vérifiée ici,
 * pas par le layout.
 *
 * Réponses : 303 vers le back-office, `?uploaded=N` ou `?error=<code>` —
 * la même convention que les actions, pour que la page affiche l'issue.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const rawLocale = String(form.get("locale") ?? DEFAULT_LOCALE);
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const back = (q: string) =>
    NextResponse.redirect(new URL(`/${locale}/backoffice?${q}#photos`, request.url), 303);

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(`/${locale}/login?error=sessionExpired&next=/${locale}/backoffice`, request.url), 303);
  }

  const reference = String(form.get("reference") ?? "").trim().toUpperCase();
  const property = reference
    ? await queryOne<{ id: string }>(`SELECT id FROM properties WHERE reference = $1`, [reference])
    : null;
  if (!property) return back("error=unknown_reference");
  if (!(await canManageProperty(pool, user, property.id))) return back("error=forbidden");

  // Un champ fichier vide soumet un File de 0 octet sans nom : il ne compte pas.
  const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  // Bornes vérifiées sur les tailles annoncées AVANT de lire les corps :
  // inutile de charger vingt fichiers en mémoire pour refuser le vingt-et-unième.
  if (files.length === 0) return back("error=no_files");
  if (files.length > MAX_PHOTOS_PER_UPLOAD) return back("error=too_many");
  if (files.some((f) => f.size > MAX_PHOTO_BYTES)) return back("error=too_large");

  let photos;
  try {
    photos = validatePhotos(await Promise.all(files.map(async (f) => Buffer.from(await f.arrayBuffer()))));
  } catch (err) {
    return back(`error=${(err as Error).message}`);
  }

  try {
    const store = createMediaStore();
    const stored = await withTransaction(async (client) => {
      const rows = await storePhotos(client, store, { propertyId: property.id, photos, userId: user.id });
      await recordAudit(client, actorFromUser(user), {
        action: "media_uploaded",
        targetType: "property",
        targetId: property.id,
        targetLabel: reference,
        details: {
          count: rows.length,
          bytes: rows.reduce((sum: number, r: { bytes: number }) => sum + r.bytes, 0),
          mediaIds: rows.map((r: { id: string }) => r.id),
          storage: store.provider,
        },
      });
      return rows;
    });
    revalidatePath("/[locale]/backoffice", "page");
    revalidatePath("/[locale]/property/[reference]", "page");
    return back(`uploaded=${stored.length}`);
  } catch {
    return back("error=upload_failed");
  }
}
