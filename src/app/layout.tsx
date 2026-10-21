import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clinic AI - Front-desk automation (demo)",
  description:
    "AI-assisted appointment booking and clinic operations dashboard. Demo with synthetic data only. Administrative help, not medical advice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          Demo environment: all data is synthetic. This service provides administrative help only and is not medical
          advice. In an emergency, call your local emergency number.
        </div>
        {children}
      </body>
    </html>
  );
}
