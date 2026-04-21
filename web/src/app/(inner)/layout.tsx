import { DisclaimerBanner } from "@/components/DisclaimerBanner";

export default function InnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <DisclaimerBanner />
      <main className="mx-auto max-w-3xl p-6">{children}</main>
    </div>
  );
}
