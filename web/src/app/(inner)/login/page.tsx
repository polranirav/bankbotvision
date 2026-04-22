"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";

type Mode = "choose" | "email" | "face";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("choose");
  const [agentName, setAgentName] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryMode = params.get("mode");
    setAgentName(params.get("agent"));
    if (queryMode === "email" || queryMode === "face") {
      setMode(queryMode);
    }
  }, []);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setError(error.message);
    router.push("/account");
  }

  async function handleFace(result: CaptureResult) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/face/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descriptor: result.descriptor }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Face not recognised" }));
        setError(body.detail ?? "Face not recognised");
        setMode("choose");
        return;
      }

      const { magic_link } = await res.json();
      // Follow the magic link — Supabase sets the session cookie then redirects back
      window.location.href = magic_link;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMode("choose");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 py-10 max-w-sm">
      <h1 className="text-2xl font-semibold">Log in</h1>
      {agentName && (
        <p className="text-sm text-neutral-500">
          You walked up to {agentName}. Continue with the sign-in option that fits your visit.
        </p>
      )}

      {mode === "choose" && (
        <div className="flex flex-col gap-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={() => setMode("face")} className="rounded bg-neutral-900 px-4 py-3 text-white text-left hover:bg-neutral-700">
            <span className="text-lg">📷</span> <span className="font-medium">Sign in with Face</span>
            <p className="text-xs text-neutral-300 mt-0.5">Robot recognises you automatically</p>
          </button>
          <button onClick={() => setMode("email")} className="rounded border border-neutral-300 px-4 py-3 text-left hover:bg-neutral-50">
            <span className="text-lg">✉️</span> <span className="font-medium">Sign in with Email</span>
            <p className="text-xs text-neutral-500 mt-0.5">Use your email + password</p>
          </button>
        </div>
      )}

      {mode === "email" && (
        <form onSubmit={handleEmail} className="space-y-4">
          <input className="w-full rounded border border-neutral-300 px-3 py-2" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="w-full rounded border border-neutral-300 px-3 py-2" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode("choose")} className="rounded border border-neutral-300 px-4 py-2 hover:bg-neutral-50">← Back</button>
            <button className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700">Log in</button>
          </div>
        </form>
      )}

      {mode === "face" && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-500">Look at the camera — the robot will recognise you automatically.</p>
          {busy ? (
            <p className="text-sm text-neutral-500">Matching face…</p>
          ) : (
            <FaceCapture onCapture={handleFace} onError={(msg) => { setError(msg); setMode("choose"); }} matchOnly />
          )}
          <button onClick={() => setMode("choose")} className="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">← Back</button>
        </div>
      )}
    </div>
  );
}
