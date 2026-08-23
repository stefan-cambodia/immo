import type { Metadata } from "next";
import { LandingPage, buildMetadata } from "@/components/LandingPage";

// Page d'atterrissage quartier × transaction × langue (phase 3).
export const revalidate = 900;

type Params = Promise<{ locale: string; txn: string; area: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return buildMetadata(await params) as Metadata;
}

export default async function Page({ params }: { params: Params }) {
  return <LandingPage params={await params} />;
}
