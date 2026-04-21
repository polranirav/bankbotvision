"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setError(error.message);
    router.push("/account");
  }

  return (
    <div className="space-y-6 py-10 max-w-sm">
      <h1 className="text-2xl font-semibold">Log in</h1>
      <form onSubmit={handleLogin} className="space-y-4">
        <input
          className="w-full rounded border border-neutral-300 px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full rounded border border-neutral-300 px-3 py-2"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700">
          Log in
        </button>
      </form>
      <button
        type="button"
        disabled
        className="rounded border border-neutral-300 px-4 py-2 text-neutral-400"
        title="Arrives in Phase 2"
      >
        Face login (coming soon)
      </button>
    </div>
  );
}
