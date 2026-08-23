import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n";

/**
 * Garde de rendu du back-office. Elle empêche l'affichage, pas l'exécution :
 * les actions serveur vérifient la session de leur côté (voir `actions.ts`).
 */
export default async function BackofficeLayout({
  children, params,
}: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/${locale}/login?next=${encodeURIComponent(`/${locale}/backoffice`)}`);
  }

  return children;
}
