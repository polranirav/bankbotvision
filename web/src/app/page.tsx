import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-6 py-10">
      <h1 className="text-3xl font-semibold">BankBot Vision</h1>
      <p className="text-neutral-700">
        A virtual bank where animated robots greet you by face and chat about your
        account. This is Phase 1 — email signup and account CRUD. Face login, 3D
        robots, and voice arrive in later phases.
      </p>
      <div className="flex gap-3">
        <Link
          href="/signup"
          className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700"
        >
          Create account
        </Link>
        <Link
          href="/login"
          className="rounded border border-neutral-300 px-4 py-2 hover:bg-neutral-100"
        >
          Log in
        </Link>
      </div>
      <div className="rounded border border-dashed border-neutral-300 p-6 text-sm text-neutral-500">
        Robot selector (Three.js + Ready Player Me) will live here in Phase 3.
      </div>
    </div>
  );
}
