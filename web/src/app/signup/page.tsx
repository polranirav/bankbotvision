"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { api } from "@/lib/api";
import { AccountForm } from "@/components/AccountForm";
import type { AccountCreate } from "@/types/account";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [credsSubmitted, setCredsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreds(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Create the user via our FastAPI admin endpoint (auto-confirmed — sidesteps
    // Supabase's email-confirmation flow regardless of dashboard settings).
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/signup`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      return setError(`Signup failed: ${body}`);
    }

    // Now obtain a real browser session.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) return setError(signInError.message);
    setCredsSubmitted(true);
  }

  async function handleAccount(values: AccountCreate) {
    await api("/accounts", { method: "POST", body: JSON.stringify(values) });
    router.push("/account");
  }

  if (!credsSubmitted) {
    return (
      <div className="space-y-6 py-10">
        <h1 className="text-2xl font-semibold">Create your account</h1>
        <form onSubmit={handleCreds} className="space-y-4 max-w-sm">
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
            minLength={8}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700">
            Continue
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-10">
      <h1 className="text-2xl font-semibold">Tell us about your finances</h1>
      <p className="text-sm text-neutral-600">
        CIBC-style demo data. All of this is fake — used only so the bot has
        something to talk about later.
      </p>
      <AccountForm submitLabel="Create account" onSubmit={handleAccount} />
    </div>
  );
}
