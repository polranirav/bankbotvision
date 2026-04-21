import type { Metadata } from "next";
import "./globals.css";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

export const metadata: Metadata = {
  title: "BankBot Vision",
  description: "Prototype virtual bank — demo only.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <DisclaimerBanner />
        <main className="mx-auto max-w-3xl p-6">{children}</main>
      </body>
    </html>
  );
}
