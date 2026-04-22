"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { api } from "@/lib/api";
import { AccountForm } from "@/components/AccountForm";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import type { AccountCreate } from "@/types/account";

type Step = "creds" | "account" | "face";

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("creds");
  const [agentName, setAgentName] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setAgentName(params.get("agent"));
  }, []);

  // Step 1 — credentials
  async function handleCreds(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.text();
      return setError(`Signup failed: ${body}`);
    }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return setError(signInError.message);
    setStep("account");
  }

  // Step 2 — account data
  async function handleAccount(values: AccountCreate) {
    await api("/accounts", { method: "POST", body: JSON.stringify(values) });
    setStep("face");
  }

  // Step 3 — face capture
  async function handleFace(result: CaptureResult) {
    setError(null);
    setBusy(true);
    try {
      await api("/face/save", {
        method: "POST",
        body: JSON.stringify({
          descriptor: result.descriptor,
          image_data_url: result.imageDataUrl,
        }),
      });
      router.push("/account");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const stepLabel = { creds: "1", account: "2", face: "3" }[step];

  return (
    <div className="space-y-6 py-10">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm text-neutral-500">
        {(["creds", "account", "face"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step === s ? "bg-neutral-900 text-white" : "bg-neutral-200 text-neutral-500"}`}>
              {i + 1}
            </span>
            <span className={step === s ? "text-neutral-900 font-medium" : ""}>
              {["Email & Password", "Your Finances", "Face Scan"][i]}
            </span>
            {i < 2 && <span className="text-neutral-300">→</span>}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === "creds" && (
        <>
          <h1 className="text-2xl font-semibold">Create your account</h1>
          {agentName && (
            <p className="max-w-xl text-sm text-neutral-500">
              {agentName} has already welcomed you at the front desk. This is the next step in that account-opening visit.
            </p>
          )}
          <form onSubmit={handleCreds} className="space-y-4 max-w-sm">
            <input className="w-full rounded border border-neutral-300 px-3 py-2" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="w-full rounded border border-neutral-300 px-3 py-2" type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button disabled={busy} className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700 disabled:opacity-50">
              {busy ? "Creating…" : "Continue"}
            </button>
          </form>
        </>
      )}

      {/* Step 2 */}
      {step === "account" && (
        <>
          <h1 className="text-2xl font-semibold">Your finances</h1>
          <p className="text-sm text-neutral-500">CIBC-style demo data — only used so the robot has something to talk about.</p>
          <AccountForm submitLabel="Continue →" onSubmit={handleAccount} />
        </>
      )}

      {/* Step 3 */}
      {step === "face" && (
        <>
          <h1 className="text-2xl font-semibold">Register your face</h1>
          <p className="text-sm text-neutral-500">This is how the robot will recognise you next time. Look at the camera and click Capture.</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <FaceCapture onCapture={handleFace} onError={setError} />
          {busy && <p className="text-sm text-neutral-500">Saving face data…</p>}
        </>
      )}
    </div>
  );
}
