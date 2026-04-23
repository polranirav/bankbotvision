"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { api } from "@/lib/api";
import { AccountForm } from "@/components/AccountForm";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import type { Account } from "@/types/account";

type Expense = { id: number; category: string; amount: string; occurred_at: string };

const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍔", rent: "🏠", transport: "🚌", subscriptions: "📱",
  entertainment: "🎬", shopping: "🛍️", utilities: "💡",
};

function fmt(n: string | number) {
  return Number(n).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}

function CreditBar({ score }: { score: number }) {
  const pct = ((score - 300) / 600) * 100;
  const color = score >= 740 ? "bg-green-500" : score >= 670 ? "bg-yellow-400" : "bg-red-400";
  const label = score >= 740 ? "Excellent" : score >= 670 ? "Good" : score >= 580 ? "Fair" : "Poor";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-neutral-500">
        <span>300</span><span>900</span>
      </div>
      <div className="h-2 rounded-full bg-neutral-200">
        <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-neutral-500">{label}</p>
    </div>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Face ID panel state
  const [facePanel, setFacePanel] = useState<"closed" | "register" | "confirm-delete">("closed");
  const [faceBusy, setFaceBusy] = useState(false);
  const [faceMsg, setFaceMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { router.push("/login"); return; }
      try {
        const [acc, exp] = await Promise.all([
          api<Account>("/accounts/me"),
          api<Expense[]>("/expenses/me?months=3").catch(() => []),
        ]);
        setAccount(acc);
        setExpenses(exp);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function handleUpdate(values: Parameters<typeof AccountForm>[0]["initial"]) {
    const updated = await api<Account>("/accounts/me", { method: "PUT", body: JSON.stringify(values) });
    setAccount(updated);
    setEditing(false);
  }

  // ── Face ID: register / update ──────────────────────────────────────────
  async function handleFaceCapture(result: CaptureResult) {
    setFaceBusy(true);
    setFaceMsg(null);
    try {
      await api("/face/save", {
        method: "POST",
        body: JSON.stringify({ image_data_url: result.imageDataUrl }),
      });
      // Refresh account to pick up new face_image_path
      const updated = await api<Account>("/accounts/me");
      setAccount(updated);
      setFaceMsg({ type: "ok", text: "Face ID registered successfully." });
      setFacePanel("closed");
    } catch (e) {
      setFaceMsg({ type: "err", text: e instanceof Error ? e.message : "Could not save face." });
    } finally {
      setFaceBusy(false);
    }
  }

  // ── Face ID: delete ──────────────────────────────────────────────────────
  async function handleFaceDelete() {
    setFaceBusy(true);
    setFaceMsg(null);
    try {
      // Clear face fields via account update endpoint
      await api("/face/delete", { method: "DELETE" });
      const updated = await api<Account>("/accounts/me");
      setAccount(updated);
      setFaceMsg({ type: "ok", text: "Face ID removed." });
      setFacePanel("closed");
    } catch (e) {
      // Fallback: clear via accounts update if /face/delete not present
      try {
        await api("/accounts/me", {
          method: "PUT",
          body: JSON.stringify({ face_descriptor: null, face_image_path: null }),
        });
        const updated = await api<Account>("/accounts/me");
        setAccount(updated);
        setFaceMsg({ type: "ok", text: "Face ID removed." });
        setFacePanel("closed");
      } catch {
        setFaceMsg({ type: "err", text: e instanceof Error ? e.message : "Could not remove face." });
      }
    } finally {
      setFaceBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/");
  }

  if (loading) return <div className="py-20 text-center text-neutral-400">Loading…</div>;
  if (error)   return <div className="py-20 text-center text-red-500">{error}</div>;
  if (!account) return null;

  const hasFaceId = Boolean(account.face_image_path);
  const creditUsedPct = account.credit_limit && Number(account.credit_limit) > 0
    ? Math.min(100, (Number(account.credit_balance) / Number(account.credit_limit)) * 100)
    : 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-6 py-8">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{greeting}, {account.first_name} 👋</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {hasFaceId ? "🟢 Face ID active" : "⚪ No Face ID set up"}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing(!editing)} className="rounded border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50">
            {editing ? "Cancel" : "✏️ Edit"}
          </button>
          <button onClick={signOut} className="rounded border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50">
            Sign out
          </button>
        </div>
      </div>

      {/* ── Edit form ── */}
      {editing && (
        <div className="rounded-xl border border-neutral-200 p-5 bg-neutral-50">
          <h2 className="text-sm font-semibold mb-4 text-neutral-700">Edit Account</h2>
          <AccountForm
            submitLabel="Save changes"
            initial={{
              first_name: account.first_name, last_name: account.last_name,
              address: account.address, date_of_birth: account.date_of_birth,
              chequing_balance: Number(account.chequing_balance),
              savings_balance: Number(account.savings_balance),
              credit_balance: Number(account.credit_balance),
              credit_limit: Number(account.credit_limit),
              credit_score: account.credit_score,
            }}
            onSubmit={handleUpdate}
          />
        </div>
      )}

      {/* ── Face ID card ── */}
      <div className="rounded-xl border border-neutral-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full text-xl ${hasFaceId ? "bg-green-50" : "bg-neutral-100"}`}>
              {hasFaceId ? "🟢" : "⚪"}
            </div>
            <div>
              <p className="text-sm font-semibold">Face ID</p>
              <p className="text-xs text-neutral-500">
                {hasFaceId
                  ? "Registered — the lobby robot will recognise you automatically"
                  : "Not set up — add it so the robot greets you by name"}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            {hasFaceId ? (
              <>
                <button
                  onClick={() => { setFacePanel("register"); setFaceMsg(null); }}
                  className="rounded border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50"
                >
                  Update
                </button>
                <button
                  onClick={() => { setFacePanel("confirm-delete"); setFaceMsg(null); }}
                  className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                >
                  Remove
                </button>
              </>
            ) : (
              <button
                onClick={() => { setFacePanel("register"); setFaceMsg(null); }}
                className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700"
              >
                Set up Face ID
              </button>
            )}
          </div>
        </div>

        {/* Status message */}
        {faceMsg && (
          <p className={`text-sm ${faceMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
            {faceMsg.text}
          </p>
        )}

        {/* Register / Update panel */}
        {facePanel === "register" && (
          <div className="border-t border-neutral-100 pt-4 space-y-3">
            <p className="text-sm text-neutral-600">
              Look directly at the camera, then click <strong>Capture face</strong>.
            </p>
            <FaceCapture
              onCapture={handleFaceCapture}
              onError={(msg) => setFaceMsg({ type: "err", text: msg })}
            />
            {faceBusy && <p className="text-sm text-neutral-500">Saving…</p>}
            <button
              onClick={() => setFacePanel("closed")}
              className="text-xs text-neutral-400 hover:text-neutral-600"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Confirm delete panel */}
        {facePanel === "confirm-delete" && (
          <div className="border-t border-neutral-100 pt-4 space-y-3">
            <p className="text-sm text-neutral-700">
              Are you sure you want to remove your Face ID? The lobby robot won't be able to recognise you until you set it up again.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleFaceDelete}
                disabled={faceBusy}
                className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500 disabled:opacity-50"
              >
                {faceBusy ? "Removing…" : "Yes, remove Face ID"}
              </button>
              <button
                onClick={() => setFacePanel("closed")}
                className="rounded border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Balance cards ── */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-neutral-200 p-4 space-y-1">
          <p className="text-xs text-neutral-500 uppercase tracking-wide">Chequing</p>
          <p className="text-2xl font-bold">{fmt(account.chequing_balance)}</p>
          <p className="text-xs text-neutral-400">Available balance</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 space-y-1">
          <p className="text-xs text-neutral-500 uppercase tracking-wide">Savings</p>
          <p className="text-2xl font-bold text-green-600">{fmt(account.savings_balance)}</p>
          <p className="text-xs text-neutral-400">Available balance</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 space-y-1">
          <p className="text-xs text-neutral-500 uppercase tracking-wide">Credit Card</p>
          <p className="text-2xl font-bold text-red-500">{fmt(account.credit_balance)}</p>
          <p className="text-xs text-neutral-400">of {fmt(account.credit_limit)} limit</p>
          <div className="h-1.5 rounded-full bg-neutral-200 mt-2">
            <div className="h-1.5 rounded-full bg-red-400" style={{ width: `${creditUsedPct}%` }} />
          </div>
        </div>
      </div>

      {/* ── Credit score ── */}
      {account.credit_score && (
        <div className="rounded-xl border border-neutral-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">Credit Score</p>
            <span className="text-2xl font-bold">{account.credit_score}</span>
          </div>
          <CreditBar score={account.credit_score} />
        </div>
      )}

      {/* ── Recent expenses ── */}
      <div className="rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-semibold mb-3">
          Recent Expenses <span className="text-neutral-400 font-normal text-xs">(last 3 months)</span>
        </p>
        {expenses.length === 0 ? (
          <p className="text-sm text-neutral-400">No expenses recorded yet.</p>
        ) : (
          <div className="divide-y divide-neutral-100">
            {expenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{CATEGORY_EMOJI[e.category] ?? "💳"}</span>
                  <div>
                    <p className="text-sm font-medium capitalize">{e.category}</p>
                    <p className="text-xs text-neutral-400">
                      {new Date(e.occurred_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-semibold">{fmt(e.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Account info footer ── */}
      <div className="rounded-xl border border-neutral-200 p-4 text-sm text-neutral-500 space-y-1">
        <p><span className="font-medium text-neutral-700">Name</span>: {account.first_name} {account.last_name}</p>
        {account.address && <p><span className="font-medium text-neutral-700">Address</span>: {account.address}</p>}
        {account.date_of_birth && <p><span className="font-medium text-neutral-700">Date of birth</span>: {account.date_of_birth}</p>}
        <p className="text-xs text-neutral-300 pt-1">
          Member since {new Date(account.created_at).toLocaleDateString("en-CA", { month: "long", year: "numeric" })}
        </p>
      </div>

    </div>
  );
}
