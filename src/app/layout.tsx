import type { ReactNode } from "react";
import "./globals.css";

// Le vrai <html lang> est posé par le layout de locale ; ce layout racine
// n'existe que parce que Next l'exige au-dessus du segment [locale].
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
